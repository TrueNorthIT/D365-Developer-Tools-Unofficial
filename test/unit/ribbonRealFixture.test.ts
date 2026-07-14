import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';
import { DataverseClient } from '../../src/dataverseClient';
import { parseRibbonXml } from '../../src/ribbon/ribbonXmlParser';
import type { ConnectionManager } from '../../src/connectionManager';

// Runs the real pipeline (DataverseClient.getEntityRibbonXml -> parseRibbonXml) against an actual
// RetrieveEntityRibbon response captured from a live Dataverse environment (the 'contact' entity),
// checked into test/fixtures/ribbon_response.json. Unlike ribbonIntegration.test.ts's hand-built
// fixtures, this is real production data — it's what caught two real schema mismatches that
// synthetic fixtures missed: the actual container nesting is
// RibbonDefinitions > RibbonDefinition > UI > Ribbon > Tabs (not RibbonDefinitions > RibbonXml >
// Tabs), CommandDefinitions/RuleDefinitions are siblings of UI (not nested inside Ribbon), and the
// response ships no <LocLabels> dictionary at all — every label is a $LocLabels:/$Resources:
// reference that must be shown as-is rather than resolved to blank text.

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'ribbon_response.json');
const SUBGRID_FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'ribbon_subgrid_response.json');
const ENV_URL = 'https://contoso.crm.dynamics.com';

function fakeConnectionManager(): ConnectionManager {
    return {
        connection: { environmentUrl: ENV_URL },
        getAccessToken: sinon.stub().resolves('fake-token'),
    } as unknown as ConnectionManager;
}

function fakeResponse(text: string): Response {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => text,
        headers: { get: () => null },
    } as unknown as Response;
}

describe('ribbon loading against a real captured RetrieveEntityRibbon response', () => {
    let fetchStub: sinon.SinonStub;
    let fixtureRaw: string;

    before(() => {
        fixtureRaw = fs.readFileSync(FIXTURE_PATH, 'utf8');
    });

    beforeEach(() => {
        fetchStub = sinon.stub(global, 'fetch');
    });

    afterEach(() => {
        sinon.restore();
    });

    it('decompresses and parses the real contact-entity ribbon response end-to-end', async () => {
        fetchStub.resolves(fakeResponse(fixtureRaw));

        const client = new DataverseClient(fakeConnectionManager());
        const xml = await client.getEntityRibbonXml('contact');
        const model = parseRibbonXml(xml);

        assert.strictEqual(model.tabs.length, 10);
        assert.strictEqual(model.commandDefinitions.length, 308);
        assert.strictEqual(model.enableRules.length, 168);
        assert.strictEqual(model.displayRules.length, 188);

        const expectedTabIds = [
            'Mscrm.HomepageGrid.contact.MainTab',
            'Mscrm.HomepageGrid.contact.View',
            'Mscrm.HomepageGrid.contact.Chart',
            'Mscrm.HomepageGrid.contact.Related',
            'Mscrm.HomepageGrid.contact.Developer',
            'Mscrm.Form.contact.MainTab',
            'Mscrm.Form.contact.Related',
            'Mscrm.Form.contact.Developer',
            // Contextual tabs -- nested <Tabs><ContextualTabs><ContextualGroup><Tab> rather than
            // directly under <Tabs> (see parseContextualTabs in ribbonXmlParser.ts).
            'Mscrm.HomepageGrid.AllEntities.VisualizationTab',
            'Mscrm.SubGrid.contact.MainTab',
        ];
        assert.deepStrictEqual(model.tabs.map(t => t.id), expectedTabIds);

        const mainTab = model.tabs.find(t => t.id === 'Mscrm.HomepageGrid.contact.MainTab')!;
        assert.strictEqual(mainTab.title, 'Contacts'); // a literal Title, not a reference
        assert.strictEqual(mainTab.groups.length, 7);

        const managementGroup = mainTab.groups.find(g => g.id === 'Mscrm.HomepageGrid.contact.MainTab.Management')!;
        assert.ok(managementGroup, 'expected the Management group to be present');
        assert.strictEqual(managementGroup.controls.length, 15);

        // Every control must show SOME label (literal, or the raw $LocLabels:/$Resources: reference)
        // -- never silently blank, since this payload ships no <LocLabels> dictionary to resolve
        // references against.
        for (const control of managementGroup.controls) {
            assert.ok(control.label.length > 0, `control '${control.id}' has an empty label`);
        }

        const flyout = managementGroup.controls.find(c => c.kind === 'FlyoutAnchor')!;
        assert.ok(flyout.controls?.length, 'expected the FlyoutAnchor to have a nested MenuSection');
        assert.strictEqual(flyout.controls![0].kind, 'MenuSection');
        assert.ok(flyout.controls![0].controls!.length > 0, 'expected the MenuSection to have nested controls');

        const commandsWithActions = model.commandDefinitions.filter(c => c.actions.length > 0);
        assert.strictEqual(commandsWithActions.length, 251);

        // Every action encountered in this real payload is a JavaScriptFunction or Url -- if this
        // ever fails, a new/unmodeled action shape has appeared and parseActions needs updating.
        const rawActionCommands = model.commandDefinitions.filter(c => c.actions.some(a => a.type === 'Raw'));
        assert.strictEqual(rawActionCommands.length, 0);
    });

    // Captured with RibbonLocationFilter=SubGrid explicitly (not 'All'). This is what exposed the
    // ContextualTabs nesting in the first place: unlike Form/HomepageGrid, the Sub-Grid tab isn't a
    // direct child of <Tabs> (which comes back as an empty self-closing element) -- it's nested
    // <Tabs><ContextualTabs><ContextualGroup><Tab Id="Mscrm.SubGrid.contact.MainTab">…</Tab>. Before
    // parseContextualTabs was added, this fixture parsed to zero tabs.
    it('decompresses and parses the real contact-entity Sub-Grid ribbon response end-to-end', async () => {
        fixtureRaw = fs.readFileSync(SUBGRID_FIXTURE_PATH, 'utf8');
        fetchStub.resolves(fakeResponse(fixtureRaw));

        const client = new DataverseClient(fakeConnectionManager());
        const xml = await client.getEntityRibbonXml('contact', 'SubGrid');
        const model = parseRibbonXml(xml);

        assert.strictEqual(model.tabs.length, 1);
        assert.strictEqual(model.commandDefinitions.length, 86);
        assert.strictEqual(model.enableRules.length, 56);
        assert.strictEqual(model.displayRules.length, 79);

        const tab = model.tabs[0];
        assert.strictEqual(tab.id, 'Mscrm.SubGrid.contact.MainTab');
        assert.strictEqual(tab.title, 'Contacts');
        assert.strictEqual(tab.groups.length, 9);

        const managementGroup = tab.groups.find(g => g.id === 'Mscrm.SubGrid.contact.MainTab.Management')!;
        assert.ok(managementGroup, 'expected the Management group to be present');
        assert.strictEqual(managementGroup.controls.length, 16);

        for (const control of managementGroup.controls) {
            assert.ok(control.label.length > 0, `control '${control.id}' has an empty label`);
        }

        const flyout = managementGroup.controls.find(c => c.kind === 'FlyoutAnchor')!;
        assert.ok(flyout.controls?.length, 'expected the FlyoutAnchor to have a nested MenuSection');
        assert.strictEqual(flyout.controls![0].kind, 'MenuSection');
        assert.ok(flyout.controls![0].controls!.length > 0, 'expected the MenuSection to have nested controls');

        const commandsWithActions = model.commandDefinitions.filter(c => c.actions.length > 0);
        assert.strictEqual(commandsWithActions.length, 67);

        const rawActionCommands = model.commandDefinitions.filter(c => c.actions.some(a => a.type === 'Raw'));
        assert.strictEqual(rawActionCommands.length, 0);
    });
});

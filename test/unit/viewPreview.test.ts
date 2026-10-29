import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyGlobalChoices, parseChoicesYaml, parseTableYaml, parseViewYaml } from '../../src/form/formModel';
import { SiblingTableLoader } from '../../src/form/viewLoader';
import { dataverseErrorMessage, describeFilter, LabelResolver } from '../../src/view/viewQuery';
import { renderViewHtml, viewTypeLabel } from '../../src/view/viewRenderer';

const CHOICES = `- name: tn_salutation
  displayName: Salutation
  description: ''
  options:
  - value: 876080000
    label: Mr
  - value: 876080001
    label: Mrs
- name: tn_empty
  displayName: Nothing
`;

const TABLE = `entity: contact
displayName: Contact
attributes:
- name: tn_title
  type: Picklist
  displayName: Title
  globalOptionSetName: tn_salutation
- name: statecode
  type: State
  displayName: Status
  globalOptionSetName: tn_salutation
  options:
  - value: 0
    label: Active
- name: fullname
  type: String
  displayName: Full Name
`;

const VIEW = `view: Active Contacts
entity: contact
isDefault: true
fetchXml: |-
  <fetch version="1.0"><entity name="contact"><attribute name="fullname"/><attribute name="tn_title"/><order attribute="fullname" descending="true"/><filter><condition attribute="statecode" operator="eq" value="0"/></filter></entity></fetch>
layoutXml: |-
  <grid name="resultset"><row name="result" id="contactid"><cell name="fullname" width="300"/><cell name="tn_title" width="100"/></row></grid>
`;

describe('view previewer', () => {
    describe('global choices (REQ-8)', () => {
        it('parses choices.yml into name -> value -> label, skipping choices without options', () => {
            const choices = parseChoicesYaml(CHOICES).model!;
            assert.strictEqual(choices.get('tn_salutation')?.get(876080001), 'Mrs');
            assert.strictEqual(choices.has('tn_empty'), false);
        });

        it('rejects a choices file that is not a list', () => {
            assert.ok(parseChoicesYaml('name: x').errors.length > 0);
        });

        it('fills options for attributes that reference a global choice, without touching inline options', () => {
            const table = parseTableYaml(TABLE).model!;
            const merged = applyGlobalChoices(table, parseChoicesYaml(CHOICES).model);
            assert.strictEqual(merged.attributes.get('tn_title')?.options?.get(876080000), 'Mr');
            assert.deepStrictEqual([...merged.attributes.get('statecode')!.options!.entries()], [[0, 'Active']], 'Expected inline options to win');
            assert.strictEqual(merged.attributes.get('fullname')?.options, undefined);
            assert.strictEqual(table.attributes.get('tn_title')?.options, undefined, 'Expected the original (cached) table not to be mutated');
        });

        it('lets describeFilter label a global choice value', () => {
            const table = applyGlobalChoices(parseTableYaml(TABLE).model!, parseChoicesYaml(CHOICES).model);
            const xml = '<fetch><entity name="contact"><filter><condition attribute="tn_title" operator="eq" value="876080001"/></filter></entity></fetch>';
            assert.strictEqual(describeFilter(xml, { table }), 'Title equals Mrs');
        });

        it('loads choices.yml from the export root (and nothing when it is absent)', () => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-choices-'));
            try {
                assert.strictEqual(new SiblingTableLoader(root).loadChoices(), undefined);
                fs.writeFileSync(path.join(root, 'choices.yml'), CHOICES);
                assert.strictEqual(new SiblingTableLoader(root).loadChoices()?.get('tn_salutation')?.get(876080000), 'Mr');
            } finally {
                fs.rmSync(root, { recursive: true, force: true });
            }
        });
    });

    describe('viewTypeLabel (REQ-3)', () => {
        it('maps d365architect query types to the names Dynamics uses', () => {
            assert.strictEqual(viewTypeLabel(undefined), 'Public view');
            assert.strictEqual(viewTypeLabel('SubGrid'), 'Associated view');
            assert.strictEqual(viewTypeLabel('LookupView'), 'Lookup view');
            assert.strictEqual(viewTypeLabel('QuickFindSearch'), 'Quick find view');
            assert.strictEqual(viewTypeLabel('OfflineTemplate'), 'OfflineTemplate');
        });
    });

    describe('dataverseErrorMessage (REQ-12)', () => {
        it('pulls the message out of a Dataverse error body', () => {
            assert.strictEqual(dataverseErrorMessage('Dataverse API error 400: {"error":{"code":"0x0","message":"\'contact\' entity doesn\'t contain attribute"}}'),
                '\'contact\' entity doesn\'t contain attribute');
        });

        it('returns the text as given when there is no JSON body', () => {
            assert.strictEqual(dataverseErrorMessage('Dataverse API error 500: Server Error'), 'Dataverse API error 500: Server Error');
        });
    });

    describe('renderViewHtml', () => {
        const view = parseViewYaml(VIEW).model!;
        const labels: LabelResolver = { table: parseTableYaml(TABLE).model! };

        it('REQ-3/6/7: shows the details, sort arrow and filter', () => {
            const html = renderViewHtml({ view, labels, rows: { kind: 'signed-out' } });
            assert.ok(html.includes('Active Contacts'));
            assert.ok(html.includes('Public view · Default'));
            assert.ok(/<th[^>]*aria-sort="descending"[^>]*>Full Name<span class="sort-arrow">↓<\/span><\/th>/.test(html), html);
            assert.ok(html.includes('Full Name (descending)'));
            assert.ok(html.includes('Status equals Active'));
            assert.ok(html.includes('width:calc((100% - 44px) * 0.75)'), 'Expected a share proportional to the layout width');
            assert.ok(html.includes('min-width:444px'), 'Expected the layout widths as the minimum table width');
        });

        it('REQ-11: asks to sign in when not connected', () => {
            const html = renderViewHtml({ view, labels, rows: { kind: 'signed-out' } });
            assert.ok(html.includes('Sign in to Dynamics to load rows'));
        });

        it('REQ-12: shows the Dynamics error above an empty grid, escaped', () => {
            const html = renderViewHtml({ view, labels, rows: { kind: 'error', message: 'Bad <attr>', environment: 'https://x.crm11.dynamics.com' } });
            assert.ok(html.includes('Bad &lt;attr&gt;'));
            assert.ok(html.includes('<tbody></tbody>'));
            assert.ok(html.includes('<th'), 'Expected the grid headers to still render');
        });

        it('REQ-10: shows the rows with the environment they came from', () => {
            const records = [{ fullname: 'Ann', 'tn_title@OData.Community.Display.V1.FormattedValue': 'Mrs', tn_title: 876080001 }];
            const html = renderViewHtml({ view, labels, rows: { kind: 'rows', records, environment: 'https://prod.crm11.dynamics.com' }, maxRows: 50 });
            assert.ok(html.includes('<td title="Ann">Ann</td><td title="Mrs">Mrs</td>'), html);
            assert.ok(html.includes('1 row from https://prod.crm11.dynamics.com'));
        });
    });
});

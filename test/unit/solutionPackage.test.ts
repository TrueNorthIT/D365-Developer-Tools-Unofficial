import * as assert from 'assert';
import { buildRibbonSolutionZip, extractRibbonDiffXmlFromCustomizations, hasRibbonChanges } from '../../src/ribbon/solutionPackage';
import type { RibbonModel } from '../../src/ribbon/ribbonModel';
import type { EntityRibbonMetadata } from '../../src/dataverseClient';

function baseMetadata(overrides: Partial<EntityRibbonMetadata> = {}): EntityRibbonMetadata {
    return {
        metadataId: 'entity-metadata-id',
        schemaName: 'tn_JCTesttable',
        displayName: 'JC Test table',
        displayCollectionName: 'JC Test tables',
        description: '',
        entitySetName: 'tn_jctesttables',
        ownershipType: 'UserOwned',
        introducedVersion: '1.0',
        ...overrides,
    };
}

function baseModel(): RibbonModel {
    return {
        tabs: [
            {
                id: 'Mscrm.form.account.MainTab',
                title: 'Home',
                status: 'unchanged',
                groups: [
                    {
                        id: 'grp1',
                        title: 'Group',
                        status: 'unchanged',
                        controls: [
                            { kind: 'Button', id: 'btn1', label: 'Button', toolTipTitle: '', toolTipDescription: '', status: 'unchanged' },
                        ],
                    },
                ],
            },
        ],
        commandDefinitions: [],
        enableRules: [],
        displayRules: [],
        locLabels: {},
    };
}

describe('buildRibbonSolutionZip', () => {
    it('produces a zip containing solution.xml, customizations.xml, and [Content_Types].xml', () => {
        const zip = buildRibbonSolutionZip({
            entityLogicalName: 'account',
            entityDisplayName: 'Account',
            entityMetadata: baseMetadata(),
            ribbonDiffXml: '<RibbonDiffXml><CustomActions /></RibbonDiffXml>',
            publisherUniqueName: 'mypublisher',
            solutionUniqueName: 'd365vscodetools_ribbon_123',
            solutionFriendlyName: 'Ribbon changes: Account (temporary)',
        });
        const text = zip.toString('latin1');

        for (const name of ['solution.xml', 'customizations.xml', '[Content_Types].xml']) {
            assert.ok(text.includes(name), `expected zip to contain an entry named '${name}'`);
        }
    });

    it('embeds the entity name, publisher, solution name, and ribbon diff verbatim (stored/uncompressed entries)', () => {
        const zip = buildRibbonSolutionZip({
            entityLogicalName: 'account',
            entityDisplayName: 'Account',
            entityMetadata: baseMetadata({ schemaName: 'Account' }),
            ribbonDiffXml: '<RibbonDiffXml><CustomActions><CustomAction Id="my.custom.action" /></CustomActions></RibbonDiffXml>',
            publisherUniqueName: 'mypublisher',
            solutionUniqueName: 'd365vscodetools_ribbon_123',
            solutionFriendlyName: 'Ribbon changes: Account (temporary)',
        });
        const text = zip.toString('utf8');

        assert.match(text, /<Name LocalizedName="Account" OriginalName="Account">Account<\/Name>/);
        assert.ok(text.includes('<UniqueName>mypublisher</UniqueName>'), 'expected the publisher unique name in solution.xml');
        assert.ok(text.includes('<UniqueName>d365vscodetools_ribbon_123</UniqueName>'), 'expected the solution unique name in solution.xml');
        assert.ok(text.includes('schemaName="account"'), 'expected the RootComponent to reference the entity by schemaName');
        assert.ok(text.includes('<CustomAction Id="my.custom.action" />'), 'expected the ribbon diff XML to be embedded verbatim');
    });

    it('embeds a live-fetched EntityInfo block, not a guessed/omitted one', () => {
        const zip = buildRibbonSolutionZip({
            entityLogicalName: 'tn_jctesttable',
            entityDisplayName: 'JC Test table',
            entityMetadata: baseMetadata(),
            ribbonDiffXml: '<RibbonDiffXml />',
            publisherUniqueName: 'mypublisher',
            solutionUniqueName: 'd365vscodetools_ribbon_123',
            solutionFriendlyName: 'Ribbon changes: JC Test table (temporary)',
        });
        const text = zip.toString('utf8');

        assert.ok(text.includes('<EntityInfo>'), 'expected an EntityInfo block');
        assert.match(text, /<entity Name="tn_JCTesttable">/);

        // Regression test: <Entity><Name> and <EntityInfo><entity Name="..."> must use the exact
        // same (schema-name-cased) string -- a real import fails outright ("Not all instances of the
        // entity name match") if they disagree, which happened when <Name>'s text content used the
        // lowercase logical name while EntityInfo correctly used the schema name.
        const nameMatch = /<Name[^>]*>([^<]+)<\/Name>/.exec(text);
        const entityInfoMatch = /<entity Name="([^"]+)">/.exec(text);
        assert.ok(nameMatch && entityInfoMatch, 'expected to find both <Name> and <entity Name="...">');
        assert.strictEqual(nameMatch![1], entityInfoMatch![1]);

        assert.match(text, /<LocalizedName description="JC Test table" languagecode="1033" \/>/);
        assert.match(text, /<LocalizedCollectionName description="JC Test tables" languagecode="1033" \/>/);
        assert.match(text, /<EntitySetName>tn_jctesttables<\/EntitySetName>/);
        assert.match(text, /<OwnershipTypeMask>UserOwned<\/OwnershipTypeMask>/);
        assert.match(text, /<IntroducedVersion>1\.0<\/IntroducedVersion>/);
        assert.match(text, /<attributes \/>/);
    });

    it('declares a self-referential MissingDependency for the entity, matching a real minimal ribbon-only export', () => {
        const zip = buildRibbonSolutionZip({
            entityLogicalName: 'account',
            entityDisplayName: 'Account',
            entityMetadata: baseMetadata(),
            ribbonDiffXml: '<RibbonDiffXml />',
            publisherUniqueName: 'mypublisher',
            solutionUniqueName: 'd365vscodetools_ribbon_123',
            solutionFriendlyName: 'Ribbon changes: Account (temporary)',
        });
        const text = zip.toString('utf8');

        assert.match(text, /<Required type="1" schemaName="account" displayName="Account" solution="Active" \/>/);
        assert.match(text, /<Dependent type="1" schemaName="account" displayName="Account" \/>/);
    });

    it('escapes XML-significant characters in the friendly name', () => {
        const zip = buildRibbonSolutionZip({
            entityLogicalName: 'account',
            entityDisplayName: 'Account',
            entityMetadata: baseMetadata(),
            ribbonDiffXml: '<RibbonDiffXml />',
            publisherUniqueName: 'mypublisher',
            solutionUniqueName: 'd365vscodetools_ribbon_123',
            solutionFriendlyName: 'Ribbon changes: A & B "Test" <entity>',
        });
        const text = zip.toString('utf8');
        assert.ok(text.includes('A &amp; B &quot;Test&quot; &lt;entity&gt;'));
    });

    it('falls back to the entity logical name when no display name is given', () => {
        const zip = buildRibbonSolutionZip({
            entityLogicalName: 'account',
            entityDisplayName: '',
            entityMetadata: baseMetadata(),
            ribbonDiffXml: '<RibbonDiffXml />',
            publisherUniqueName: 'mypublisher',
            solutionUniqueName: 'd365vscodetools_ribbon_123',
            solutionFriendlyName: 'Ribbon changes: Account (temporary)',
        });
        const text = zip.toString('utf8');
        assert.match(text, /<Required type="1" schemaName="account" displayName="account" solution="Active" \/>/);
    });
});

describe('hasRibbonChanges', () => {
    it('returns false for a model where nothing has changed', () => {
        assert.strictEqual(hasRibbonChanges(baseModel()), false);
    });

    it('returns true when a tab status changed', () => {
        const model = baseModel();
        model.tabs[0].status = 'modified';
        assert.strictEqual(hasRibbonChanges(model), true);
    });

    it('returns true when a group status changed', () => {
        const model = baseModel();
        model.tabs[0].groups[0].status = 'added';
        assert.strictEqual(hasRibbonChanges(model), true);
    });

    it('returns true when a control status changed', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls[0].status = 'deleted';
        assert.strictEqual(hasRibbonChanges(model), true);
    });

    it('returns true when a nested (flyout menu) control status changed', () => {
        const model = baseModel();
        model.tabs[0].groups[0].controls.push({
            kind: 'FlyoutAnchor',
            id: 'flyout1',
            label: 'Flyout',
            toolTipTitle: '',
            toolTipDescription: '',
            status: 'unchanged',
            controls: [
                { kind: 'MenuSection', id: 'section1', label: '', toolTipTitle: '', toolTipDescription: '', status: 'unchanged', controls: [
                    { kind: 'Button', id: 'nested.btn', label: 'Nested', toolTipTitle: '', toolTipDescription: '', status: 'added' },
                ] },
            ],
        });
        assert.strictEqual(hasRibbonChanges(model), true);
    });

    it('returns true when a command definition, enable rule, or display rule changed', () => {
        const withCommand = baseModel();
        withCommand.commandDefinitions.push({ id: 'cmd1', enableRules: [], displayRules: [], actions: [], status: 'added' });
        assert.strictEqual(hasRibbonChanges(withCommand), true);

        const withEnableRule = baseModel();
        withEnableRule.enableRules.push({ id: 'rule1', xml: '<EnableRule Id="rule1" />', status: 'added' });
        assert.strictEqual(hasRibbonChanges(withEnableRule), true);

        const withDisplayRule = baseModel();
        withDisplayRule.displayRules.push({ id: 'rule2', xml: '<DisplayRule Id="rule2" />', status: 'added' });
        assert.strictEqual(hasRibbonChanges(withDisplayRule), true);
    });
});

describe('extractRibbonDiffXmlFromCustomizations', () => {
    it('extracts the RibbonDiffXml block verbatim, tags included', () => {
        const customizationsXml = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml><Entities><Entity><Name>tn_jctesttable</Name><RibbonDiffXml><CustomActions><CustomAction Id="x.Custom" /></CustomActions></RibbonDiffXml></Entity></Entities></ImportExportXml>`;

        const result = extractRibbonDiffXmlFromCustomizations(customizationsXml);
        assert.strictEqual(result, '<RibbonDiffXml><CustomActions><CustomAction Id="x.Custom" /></CustomActions></RibbonDiffXml>');
    });

    it('returns undefined when there is no RibbonDiffXml element at all', () => {
        const customizationsXml = `<ImportExportXml><Entities><Entity><Name>tn_jctesttable</Name></Entity></Entities></ImportExportXml>`;
        assert.strictEqual(extractRibbonDiffXmlFromCustomizations(customizationsXml), undefined);
    });

    it('returns undefined for a self-closing (empty) RibbonDiffXml element', () => {
        const customizationsXml = `<ImportExportXml><Entities><Entity><Name>tn_jctesttable</Name><RibbonDiffXml /></Entity></Entities></ImportExportXml>`;
        assert.strictEqual(extractRibbonDiffXmlFromCustomizations(customizationsXml), undefined);
    });
});

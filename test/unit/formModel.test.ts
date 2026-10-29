import * as assert from 'assert';
import { parseFormYaml, parseTableYaml } from '../../src/form/formModel';
import { escapeHtml, renderFormHtml, resolveKind } from '../../src/form/formRenderer';

const FORM = `
form: Information
entity: tn_thing
tabs:
- label: General
  columns:
  - width: 75%
    sections:
    - label: Main
      columns: 2
      controls:
      - id: tn_name
        field: tn_name
        label: Name
        control: SingleLineText
      - id: hidden1
        field: tn_hidden
        label: Hidden
        control: SingleLineText
        visible: false
      - id: when
        field: tn_when
        control: Lookup
        disabled: true
      - id: sg
        label: Related
        control: Subgrid
        showLabel: false
        rowSpan: 4
        columnSpan: 2
        parameters:
          TargetEntityType: contact
  - width: 25%
    sections: []
headerControls:
- id: header_tn_name
  field: tn_name
  control: SingleLineText
`;

const TABLE = `
entity: tn_thing
displayName: Thing
attributes:
- name: tn_name
  type: String
  displayName: Name (table)
  requiredLevel: ApplicationRequired
- name: tn_when
  type: DateTime
  displayName: When
  format: DateOnly
  requiredLevel: Recommended
`;

describe('formModel', () => {
    describe('parseFormYaml', () => {
        it('parses tabs, sections and controls with defaults applied', () => {
            const { model, errors } = parseFormYaml(FORM);
            assert.deepStrictEqual(errors, []);
            assert.ok(model);
            assert.strictEqual(model.type, 'Main');
            assert.strictEqual(model.tabs[0].columns.length, 2);
            const section = model.tabs[0].columns[0].sections[0];
            assert.strictEqual(section.columns, 2);
            assert.strictEqual(section.controls[0].visible, true);
            assert.strictEqual(section.controls[0].showLabel, true);
            assert.strictEqual(section.controls[1].visible, false);
            assert.strictEqual(section.controls[3].rowSpan, 4);
            assert.strictEqual(section.controls[3].columnSpan, 2);
            assert.strictEqual(model.headerControls.length, 1);
        });

        it('reports invalid YAML and non-form documents without throwing', () => {
            assert.ok(parseFormYaml('a: [').errors[0].startsWith('Invalid YAML'));
            assert.strictEqual(parseFormYaml('- 1\n- 2').model, undefined);
        });

        it('clamps section columns to 1-4', () => {
            const { model } = parseFormYaml('entity: e\ntabs:\n- columns:\n  - sections:\n    - columns: 9\n      controls: []');
            assert.strictEqual(model?.tabs[0].columns[0].sections[0].columns, 4);
        });
    });

    describe('parseTableYaml', () => {
        it('indexes attributes by name', () => {
            const { model } = parseTableYaml(TABLE);
            assert.strictEqual(model?.attributes.get('tn_when')?.requiredLevel, 'Recommended');
        });

        it('rejects a document without attributes', () => {
            assert.ok(parseTableYaml('entity: x').errors.length > 0);
        });
    });

    describe('resolveKind', () => {
        const ctl = (control: string) => ({
            control, showLabel: true, visible: true, disabled: false, isRequired: false,
            columnSpan: 1, rowSpan: 1, parameters: {},
        });

        it('prefers the table attribute type over the declared control type', () => {
            assert.strictEqual(resolveKind(ctl('Lookup'), { name: 'createdon', type: 'DateTime' }), 'datetime');
        });

        it('keeps placeholder controls regardless of attribute type', () => {
            assert.strictEqual(resolveKind(ctl('Subgrid'), { name: 'x', type: 'String' }), 'subgrid');
        });

        it('falls back to the declared control type, then text', () => {
            assert.strictEqual(resolveKind(ctl('OptionSet')), 'optionset');
            assert.strictEqual(resolveKind({ ...ctl('Unknown'), control: undefined }), 'text');
        });
    });

    describe('renderFormHtml', () => {
        const form = parseFormYaml(FORM).model!;
        const table = parseTableYaml(TABLE).model!;

        it('skips hidden controls and sizes tab columns from their widths', () => {
            const html = renderFormHtml(form, table);
            assert.ok(!html.includes('tn_hidden'));
            assert.ok(html.includes('grid-template-columns:75.00fr 25.00fr'));
            assert.ok(html.includes('grid-template-columns:repeat(2,minmax(0,1fr))'));
        });

        it('uses table display names and required markers when the label is absent or table-driven', () => {
            const html = renderFormHtml(form, table);
            assert.ok(html.includes('<span class="label-text">Name</span><span class="req"'));
            assert.ok(html.includes('class="rec"'));
            assert.ok(html.includes('class="req"'));
            assert.ok(html.includes('>When'));
        });

        it('renders spans and placeholder detail for subgrids', () => {
            const html = renderFormHtml(form, table);
            assert.ok(html.includes('grid-column:span 2;grid-row:span 4'));
            assert.ok(html.includes('ph-subgrid'));
            assert.ok(html.includes('contact'));
        });

        it('works without a table model', () => {
            const html = renderFormHtml(form);
            assert.ok(html.includes('>Name'));
            assert.ok(!html.includes('unresolved'));
        });

        it('flags fields missing from the table and escapes user content', () => {
            const evil = parseFormYaml(
                'form: "<b>x</b>"\nentity: e\ntabs:\n- label: "<i>t</i>"\n  columns:\n  - sections:\n    - controls:\n      - field: nope\n        label: "<script>"\n        control: SingleLineText',
            ).model!;
            const html = renderFormHtml(evil, table);
            assert.ok(html.includes('unresolved'));
            assert.ok(!html.includes('<script>'));
            assert.ok(!html.includes('<b>x</b>'));
        });

        const twoTabs = (type: string) => parseFormYaml(
            `entity: e\n${type ? `type: ${type}\n` : ''}tabs:\n- label: One\n  columns:\n  - sections:\n    - controls:\n      - field: a\n        control: SingleLineText\n- label: Two\n  columns:\n  - sections:\n    - controls:\n      - field: b\n        control: TwoOptions`,
        ).model!;

        it('renders a tab strip on Main forms with only the first panel active', () => {
            const html = renderFormHtml(twoTabs(''));
            assert.strictEqual((html.match(/data-tab="/g) ?? []).length, 2);
            assert.strictEqual((html.match(/tab-panel active/g) ?? []).length, 1);
            assert.ok(!html.includes('no-strip'));
        });

        it('omits the tab strip for non-Main forms', () => {
            const html = renderFormHtml(twoTabs('Quick Create'));
            assert.ok(!html.includes('data-tab="'));
            assert.ok(html.includes('no-strip'));
        });

        it('renders Two Options as a dropdown, not a toggle', () => {
            const html = renderFormHtml(twoTabs(''));
            assert.ok(html.includes('k-twooptions'));
            assert.ok(!html.includes('class="toggle"'));
        });

        const section = (columns: number, controls: string) => parseFormYaml(
            `entity: e\ntabs:\n- columns:\n  - sections:\n    - columns: ${columns}\n      controls:\n${controls}`,
        ).model!;
        const ctl = (field: string, extra = '') => `      - field: ${field}\n        control: SingleLineText\n${extra}`;

        it('deals controls into independent column stacks in YAML order (control i -> column i % n)', () => {
            const html = renderFormHtml(section(2, ['a', 'b', 'c', 'd'].map(f => ctl(f)).join('')));
            const cols = html.split('<div class="col"').slice(1);
            assert.strictEqual(cols.length, 2);
            assert.deepStrictEqual([...cols[0].matchAll(/data-field="(\w+)"/g)].map(m => m[1]), ['a', 'c']);
            assert.deepStrictEqual([...cols[1].matchAll(/data-field="(\w+)"/g)].map(m => m[1]), ['b', 'd']);
        });

        it('a hidden control still occupies its column slot', () => {
            const html = renderFormHtml(section(2, ctl('a') + ctl('h', '        visible: false\n') + ctl('c')));
            const cols = html.split('<div class="col"').slice(1);
            assert.ok(cols[0].includes('data-field="a"') && cols[0].includes('data-field="c"'));
            assert.ok(!cols[1].includes('data-field'));
        });

        it('falls back to a grid when a control uses a span', () => {
            const html = renderFormHtml(section(2, ctl('a') + ctl('b', '        columnSpan: 2\n')));
            assert.ok(html.includes('class="grid"'));
            assert.ok(!html.includes('class="cols"'));
        });

        const withHeader = (type = '') => parseFormYaml(
            `entity: e\n${type ? `type: ${type}\n` : ''}tabs:\n- label: One\n  columns:\n  - sections:\n    - controls:\n      - field: a\n        control: SingleLineText\n- label: Two\n  columns:\n  - sections: []\nheaderControls:\n- field: svc\n  label: Service\n  control: Lookup\n- field: st\n  label: Status Reason\n  control: OptionSet\n- field: gone\n  label: Hidden One\n  control: SingleLineText\n  visible: false\nfooterControls:\n- field: f\n  label: Footer Field\n  control: SingleLineText`,
        ).model!;

        it('puts header fields in the header card, beside the title and above the tab strip', () => {
            const html = renderFormHtml(withHeader());
            const card = html.slice(html.indexOf('class="form-head"'), html.indexOf('class="tab-panel'));
            assert.ok(card.includes('head-title'));
            assert.ok(card.includes('head-fields'));
            assert.ok(card.indexOf('head-title') < card.indexOf('head-fields'), 'fields to the right of the title');
            assert.ok(card.indexOf('head-fields') < card.indexOf('tab-strip'), 'tab strip underneath');
            assert.ok(!/class="strip header"/.test(html), 'no separate header strip below the tabs');
        });

        it('renders header fields as value over label, lookups as links, dividers between, hidden ones skipped', () => {
            const html = renderFormHtml(withHeader());
            assert.ok(html.includes('hf-val link'), 'lookup value is a link');
            assert.ok(html.includes('>Service<') && html.includes('>Status Reason<'));
            assert.ok(!html.includes('Hidden One'));
            assert.strictEqual((html.match(/hf-divider/g) ?? []).length, 1, 'one divider between two visible fields');
        });

        it('omits header fields on non-Main forms but keeps footer fields as a footer strip', () => {
            const html = renderFormHtml(withHeader('Quick Create'));
            assert.ok(!html.includes('head-fields'));
            assert.ok(html.includes('class="strip footer"') && html.includes('Footer Field'));
        });

        it('lays tab columns out as a proportional grid so three columns never wrap onto a new row', () => {
            const f = parseFormYaml(
                'entity: e\ntabs:\n- label: T\n  columns:\n  - width: 28%\n    sections: []\n  - width: 44%\n    sections: []\n  - width: 28%\n    sections: []',
            ).model!;
            const html = renderFormHtml(f);
            assert.ok(html.includes('grid-template-columns:28.00fr 44.00fr 28.00fr'));
            assert.strictEqual((html.match(/class="tab-col"/g) ?? []).length, 3);
        });

        it('tags multi-column sections with their column count so narrow containers can stack them', () => {
            assert.ok(renderFormHtml(section(2, ['a', 'b'].map(f => ctl(f)).join(''))).includes('class="cols" data-n="2"'));
            assert.ok(renderFormHtml(section(3, ctl('a') + ctl('b', '        columnSpan: 2\n'))).includes('class="grid" data-n="3"'));
        });

        it('shows an unbound custom (PCF) control as a labelled placeholder, but keeps bound ones as fields', () => {
            const f = parseFormYaml(
                "entity: e\ntabs:\n- columns:\n  - sections:\n    - controls:\n      - id: sla\n        customControlId: '{AAAA}'\n      - field: telephone1\n        customControlId: '{F9A8A302-114E-466A-B582-6771B2AE0D92}'",
            ).model!;
            const html = renderFormHtml(f);
            assert.ok(html.includes('ph-custom'));
            assert.ok(html.includes('Custom control'));
            assert.ok(html.includes('data-field="telephone1"') && html.includes('k-text'));
        });

        it('treats an unbound custom control carrying subgrid parameters (Power Apps grid control) as a subgrid', () => {
            const f = parseFormYaml(`entity: e
tabs:
- columns:
  - sections:
    - controls:
      - id: g
        customControlId: '{F9A8A302-114E-466A-B582-6771B2AE0D92}'
        parameters:
          TargetEntityType: task
          ViewId: '{00000000-0000-0000-00AA-000010001004}'`,
            ).model!;
            const html = renderFormHtml(f);
            assert.ok(html.includes('ph-subgrid'));
            assert.ok(!html.includes('ph-custom'));
        });

        const customControl = (webName: string, label = 'Thing') => parseFormYaml(`entity: e
tabs:
- columns:
  - sections:
    - controls:
      - id: c
        label: ${label}
        customControlId: '{F9A8A302-114E-466A-B582-6771B2AE0D92}'
        parameters:
          TargetEntityType: slakpiinstance
          ViewId: '{0696602A-B187-4BAF-8C12-3395AC7FD454}'
        additionalControls:
        - name: ${webName}
          formFactor: 2
        - name: ${webName}
          formFactor: 0`).model!;

        it('identifies a Power Apps grid by its web control name', () => {
            const html = renderFormHtml(customControl('Microsoft.PowerApps.PowerAppsOneGrid'));
            assert.ok(html.includes('ph-subgrid'));
            assert.ok(!html.includes('ph-custom'));
        });

        it('does not mistake other controls that carry subgrid parameters (SLA timer, calendar) for grids', () => {
            const html = renderFormHtml(customControl('MscrmControls.SlaTimer.SlaTimerControl', 'Registration SLA timer'));
            assert.ok(html.includes('ph-custom'));
            assert.ok(!html.includes('ph-subgrid'));
            assert.ok(html.includes('Registration SLA timer'), 'titled with the control\'s own label');
            assert.ok(html.includes('MscrmControls.SlaTimer.SlaTimerControl'), 'names the control it resolves to');
        });

        const fieldControl = (extra: string) => parseFormYaml(`entity: e
tabs:
- columns:
  - sections:
    - controls:
      - id: f
        field: f
        label: F
${extra}`).model!;
        const boolTable = parseTableYaml('entity: e\nattributes:\n- name: f\n  type: Boolean\n').model!;
        const dateTable = (format: string) => parseTableYaml(`entity: e\nattributes:\n- name: f\n  type: DateTime\n  format: ${format}\n`).model!;

        it('renders Two Options as a Fluent switch when the form uses the toggle control, otherwise a dropdown', () => {
            const toggle = renderFormHtml(fieldControl(`        customControlId: '{67FAC785-CD58-4F9F-ABB3-4B7DDC6ED5ED}'
        additionalControls:
        - name: MscrmControls.FieldControls.ToggleControl
          formFactor: 0`), boolTable);
            assert.ok(toggle.includes('k-toggle') && toggle.includes('class="sw"') && toggle.includes('sw-label'));
            assert.ok(!toggle.includes('k-twooptions'));

            const dropdown = renderFormHtml(fieldControl('        control: TwoOptions'), boolTable);
            assert.ok(dropdown.includes('k-twooptions') && !dropdown.includes('class="sw"'));
        });

        it('renders dates with the format placeholder and a calendar icon; date-time as a date input plus a time input', () => {
            const dateOnly = renderFormHtml(fieldControl('        control: DateAndTime'), dateTable('DateOnly'));
            assert.ok(dateOnly.includes('k-date') && dateOnly.includes('dd/MM/yyyy') && dateOnly.includes('<svg'));

            const both = renderFormHtml(fieldControl('        control: DateAndTime'), dateTable('DateAndTime'));
            assert.ok(both.includes('k-datetime') && both.includes('dt-date') && both.includes('dt-time'));
            assert.ok(both.includes('dd/MM/yyyy') && both.includes('hh:mm'));
        });

        it('uses outline SVG icons rather than emoji glyphs', () => {
            const html = renderFormHtml(fieldControl('        control: Lookup'));
            assert.ok(html.includes('<svg'));
            assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(html), 'no emoji in the rendered controls');
        });

        it('escapeHtml covers quotes', () => {
            assert.strictEqual(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
        });
    });
});

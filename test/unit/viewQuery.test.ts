import * as assert from 'assert';
import { parseTableYaml, parseViewYaml, TableModel } from '../../src/form/formModel';
import {
    columnLabel, columnSortDirection, describeFilter, describeSort, extractLinkEntities, extractSortOrders,
    LabelResolver, mapRows,
} from '../../src/view/viewQuery';

/**
 * Pure logic for the `*.view.yml` previewer. Production module: src/view/viewQuery.ts (no `vscode` import).
 * Option labels come from `options:` on a table attribute (src/form/formModel.ts `parseTableYaml`).
 */

const contactTable: TableModel = parseTableYaml(`entity: contact
displayName: Contact
attributes:
- name: statecode
  type: State
  displayName: Status
  options:
  - value: 0
    label: Active
  - value: 1
    label: Inactive
- name: createdon
  type: DateTime
  displayName: Created On
- name: fullname
  type: String
  displayName: Full Name
- name: parentcustomerid
  type: Lookup
  displayName: Parent Customer
- name: ownerid
  type: Owner
  displayName: Owner
- name: tn_accounttype
  type: Picklist
  displayName: Organisation Type
  options:
  - value: 876080001
    label: Provider
  - value: 876080002
    label: Health Board
- name: tn_score
  type: Integer
  displayName: Score
- name: tn_nooptions
  type: Picklist
  displayName: Unlabelled Choice
`).model!;

const accountTable: TableModel = parseTableYaml(`entity: account
displayName: Account
attributes:
- name: name
  type: String
  displayName: Account Name
- name: statuscode
  type: Status
  displayName: Status Reason
  options:
  - value: 1
    label: Dormant
`).model!;

const labels: LabelResolver = {
    table: contactTable,
    linkedTable: (entity) => (entity === 'account' ? accountTable : undefined),
};
const noTables: LabelResolver = {};

const LINK_OPEN = '<link-entity alias="a_1" name="account" to="parentcustomerid" from="accountid" link-type="outer">';
const fetch = (inner: string) => `<fetch version="1.0" output-format="xml-platform" mapping="logical"><entity name="contact">${inner}</entity></fetch>`;
const cond = (attribute: string, operator: string, value?: string, extra = '') =>
    `<condition attribute="${attribute}" operator="${operator}"${value === undefined ? '' : ` value="${value}"`}${extra}/>`;

describe('viewQuery', () => {
    // ── REQ-8 (table side): option labels must be readable from the table file ─────────────────────────────
    describe('parseTableYaml option labels (REQ-8)', () => {
        // Behaviour: `parseTableYaml` (src/form/formModel.ts) exposes a column's inline `options` list as
        // `TableAttribute.options: Map<number, string>` (value -> label), so a filter can show "Active" not "0".
        it('REQ-8: exposes inline option labels on the attribute as a value-to-label map', () => {
            const opts = contactTable.attributes.get('statecode')?.options;
            assert.ok(opts instanceof Map, 'Expected TableAttribute.options to be a Map for an attribute with inline options');
            assert.strictEqual(opts?.get(0), 'Active', 'Expected option value 0 to be labelled "Active"');
            assert.strictEqual(opts?.get(1), 'Inactive', 'Expected option value 1 to be labelled "Inactive"');
        });

        it('REQ-8: keeps large custom option values as numbers', () => {
            const opts = contactTable.attributes.get('tn_accounttype')?.options;
            assert.strictEqual(opts?.get(876080002), 'Health Board', 'Expected option 876080002 to be labelled "Health Board"');
        });

        it('REQ-8: leaves options undefined when the attribute has no inline options', () => {
            assert.strictEqual(contactTable.attributes.get('fullname')?.options, undefined,
                'Expected an attribute without `options:` to have options === undefined (not an empty map)');
        });

        it('REQ-8: ignores option entries without a numeric value rather than throwing', () => {
            const t = parseTableYaml('entity: x\nattributes:\n- name: a\n  options:\n  - value: 1\n    label: One\n  - label: NoValue\n  - value: abc\n    label: Bad\n').model!;
            assert.deepStrictEqual([...(t.attributes.get('a')?.options ?? new Map()).entries()], [[1, 'One']],
                'Expected only the well-formed option (1 -> One) to be kept');
        });
    });

    // ── REQ-6: sort orders ─────────────────────────────────────────────────────────────────────────────────
    describe('extractSortOrders (REQ-6)', () => {
        // Given FetchXML with <order> elements, `extractSortOrders` lists them in document order.
        it('REQ-6: lists root-entity orders in document order with their direction', () => {
            const xml = fetch('<attribute name="fullname"/><order attribute="createdon" descending="true"/><order attribute="fullname" descending="false"/>');
            assert.deepStrictEqual(extractSortOrders(xml), [
                { attribute: 'createdon', descending: true },
                { attribute: 'fullname', descending: false },
            ], 'Expected createdon (descending) then fullname (ascending), with no alias on root-entity orders');
        });

        it('REQ-6: treats a missing `descending` attribute as ascending', () => {
            assert.deepStrictEqual(extractSortOrders(fetch('<order attribute="fullname"/>')),
                [{ attribute: 'fullname', descending: false }], 'Expected an <order> without descending to be ascending');
        });

        it('REQ-6: reads attributes regardless of their order and of self-closing style', () => {
            assert.deepStrictEqual(extractSortOrders(fetch('<order descending="true" attribute="createdon" ></order>')),
                [{ attribute: 'createdon', descending: true }], 'Expected attribute order inside the tag not to matter');
        });

        it('REQ-6: reports orders inside a link-entity with that link-entity\'s alias', () => {
            const xml = fetch(`<order attribute="fullname"/>${LINK_OPEN}<attribute name="name"/><order attribute="name" descending="true"/></link-entity>`);
            assert.deepStrictEqual(extractSortOrders(xml), [
                { attribute: 'fullname', descending: false },
                { attribute: 'name', descending: true, alias: 'a_1' },
            ], 'Expected the linked order to carry alias a_1 and the root order to carry none');
        });

        it('REQ-6: returns an empty list when the view has no sort', () => {
            assert.deepStrictEqual(extractSortOrders(fetch('<attribute name="fullname"/>')), [], 'Expected [] when there is no <order>');
        });

        it('REQ-6: returns an empty list for malformed FetchXML instead of throwing', () => {
            for (const bad of ['', 'not xml at all', '<fetch><entity name="contact"><order attribu']) {
                assert.doesNotThrow(() => extractSortOrders(bad), `Expected no throw for ${JSON.stringify(bad)}`);
                assert.deepStrictEqual(extractSortOrders(bad), [], `Expected [] for ${JSON.stringify(bad)}`);
            }
        });
    });

    describe('columnSortDirection (REQ-6: arrow on a sorted column header)', () => {
        const sorts = [
            { attribute: 'createdon', descending: true },
            { attribute: 'fullname', descending: false },
            { attribute: 'name', descending: true, alias: 'a_1' },
        ];

        it('REQ-6: gives descending for a column sorted descending', () => {
            assert.strictEqual(columnSortDirection('createdon', sorts), 'descending', 'Expected createdon to show a descending arrow');
        });

        it('REQ-6: gives ascending for a column sorted ascending', () => {
            assert.strictEqual(columnSortDirection('fullname', sorts), 'ascending', 'Expected fullname to show an ascending arrow');
        });

        it('REQ-6: gives undefined for an unsorted column', () => {
            assert.strictEqual(columnSortDirection('telephone1', sorts), undefined, 'Expected no arrow for an unsorted column');
        });

        it('REQ-6: matches a linked column by `alias.attribute`', () => {
            assert.strictEqual(columnSortDirection('a_1.name', sorts), 'descending', 'Expected a_1.name to match the order inside link-entity a_1');
        });

        it('REQ-6: does not confuse a root column with a same-named linked column', () => {
            assert.strictEqual(columnSortDirection('name', sorts), undefined, 'Expected root `name` not to match the order on a_1.name');
        });
    });

    describe('describeSort (REQ-6: the sort order is listed)', () => {
        it('REQ-6: describes a descending sort as "Created On (descending)"', () => {
            assert.strictEqual(describeSort([{ attribute: 'createdon', descending: true }], [], labels), 'Created On (descending)',
                'Expected the display name followed by the direction in brackets');
        });

        it('REQ-6: lists several sorts in priority order, comma separated', () => {
            const text = describeSort([
                { attribute: 'createdon', descending: true },
                { attribute: 'fullname', descending: false },
            ], [], labels);
            assert.strictEqual(text, 'Created On (descending), Full Name (ascending)', 'Expected both sorts, first sort first');
        });

        it('REQ-6: falls back to the logical name when no display name is known', () => {
            assert.strictEqual(describeSort([{ attribute: 'tn_unknown', descending: false }], [], noTables), 'tn_unknown (ascending)',
                'Expected the logical name to be used without a table');
        });

        it('REQ-6: returns undefined when there is no sort', () => {
            assert.strictEqual(describeSort([], [], labels), undefined, 'Expected undefined for an unsorted view');
        });
    });

    // ── REQ-5: linked column labels ────────────────────────────────────────────────────────────────────────
    describe('extractLinkEntities (REQ-5)', () => {
        it('REQ-5: reads alias, entity and the joining attribute of each aliased link-entity', () => {
            const xml = fetch(`<attribute name="fullname"/>${LINK_OPEN}<attribute name="name"/></link-entity>`);
            assert.deepStrictEqual(extractLinkEntities(xml), [{ alias: 'a_1', entity: 'account', to: 'parentcustomerid' }],
                'Expected one link: a_1 -> account joined on parentcustomerid');
        });

        it('REQ-5: returns [] for FetchXML without links, and for malformed FetchXML', () => {
            assert.deepStrictEqual(extractLinkEntities(fetch('<attribute name="fullname"/>')), [], 'Expected [] with no link-entity');
            assert.deepStrictEqual(extractLinkEntities('<fetch><entity'), [], 'Expected [] (no throw) for malformed FetchXML');
        });
    });

    describe('columnLabel (REQ-5)', () => {
        const links = [{ alias: 'a_1', entity: 'account', to: 'parentcustomerid' }];

        it('REQ-5: labels a root column with the table\'s display name', () => {
            assert.strictEqual(columnLabel('createdon', links, labels), 'Created On', 'Expected the root column display name');
        });

        it('REQ-5: falls back to the logical name for a root column with no display name', () => {
            assert.strictEqual(columnLabel('tn_unknown', links, labels), 'tn_unknown', 'Expected the logical name as fallback');
        });

        // Example from the requirement: a_1.name linked to account -> "Account Name (Parent Customer)".
        // "Account Name" is the linked table's display name for `name`; "(Parent Customer)" is the display name of the
        // lookup (`to=parentcustomerid`) on the primary table that the link hangs off.
        it('REQ-5: labels a linked column as "<linked display name> (<lookup display name>)"', () => {
            assert.strictEqual(columnLabel('a_1.name', links, labels), 'Account Name (Parent Customer)',
                'Expected "Account Name (Parent Customer)" for a_1.name linked to account via parentcustomerid');
        });

        it('REQ-5: uses the logical names for the parts it cannot resolve', () => {
            const onlyRoot: LabelResolver = { table: contactTable, linkedTable: () => undefined };
            assert.strictEqual(columnLabel('a_1.name', links, onlyRoot), 'name (Parent Customer)',
                'Expected the linked attribute logical name when the linked table is unknown');
            assert.strictEqual(columnLabel('a_1.name', links, noTables), 'name (parentcustomerid)',
                'Expected the lookup logical name when the primary table is unknown too');
        });

        it('REQ-5: returns the column name unchanged when its alias matches no link-entity', () => {
            assert.strictEqual(columnLabel('a_9.name', links, labels), 'a_9.name', 'Expected an unknown alias to be shown as written');
        });

        it('REQ-5: works end to end from a parsed view.yml', () => {
            const yml = `view: Contacts\nentity: contact\nfetchXml: |-\n  ${fetch(`<attribute name="fullname"/>${LINK_OPEN}<attribute name="name"/></link-entity>`)}\nlayoutXml: |-\n  <grid><row><cell name="fullname"/><cell name="a_1.name"/></row></grid>\n`;
            const view = parseViewYaml(yml).model!;
            const fetchXml = fetch(`<attribute name="fullname"/>${LINK_OPEN}<attribute name="name"/></link-entity>`);
            const headers = view.columns.map(c => columnLabel(c.name, extractLinkEntities(fetchXml), labels));
            assert.deepStrictEqual(headers, ['Full Name', 'Account Name (Parent Customer)'], 'Expected headers in layout order');
        });
    });

    // ── REQ-7 / REQ-8 / REQ-9: filter description ──────────────────────────────────────────────────────────
    describe('describeFilter (REQ-7)', () => {
        it('REQ-7: returns undefined when the view has no filter', () => {
            assert.strictEqual(describeFilter(fetch('<attribute name="fullname"/>'), labels), undefined, 'Expected undefined without a <filter>');
        });

        // Example from the requirement.
        it('REQ-7: joins conditions with AND using display names and readable operators', () => {
            const xml = fetch(`<filter type="and">${cond('statecode', 'eq', '0')}${cond('createdon', 'last-x-days', '30')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Status equals Active AND Created On in the last 30 days',
                'Expected "Status equals Active AND Created On in the last 30 days"');
        });

        it('REQ-7: joins conditions of an "or" filter with OR, without brackets at the top level', () => {
            const xml = fetch(`<filter type="or">${cond('fullname', 'eq', 'Smith')}${cond('fullname', 'eq', 'Jones')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Full Name equals Smith OR Full Name equals Jones', 'Expected a flat OR list');
        });

        it('REQ-7: treats a filter without a type as AND', () => {
            const xml = fetch(`<filter>${cond('fullname', 'eq', 'A')}${cond('createdon', 'null')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Full Name equals A AND Created On does not contain data',
                'Expected the default filter type to be AND');
        });

        it('REQ-7: keeps a nested OR group inside an AND, parenthesised', () => {
            const xml = fetch(`<filter type="and">${cond('statecode', 'eq', '0')}<filter type="or">${cond('fullname', 'eq', 'Smith')}${cond('fullname', 'eq', 'Jones')}</filter></filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Status equals Active AND (Full Name equals Smith OR Full Name equals Jones)',
                'Expected the OR group to be bracketed so its meaning is preserved');
        });

        it('REQ-7: keeps a nested AND group inside an OR, parenthesised', () => {
            const xml = fetch(`<filter type="or">${cond('fullname', 'eq', 'Smith')}<filter type="and">${cond('statecode', 'eq', '0')}${cond('createdon', 'not-null')}</filter></filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Full Name equals Smith OR (Status equals Active AND Created On contains data)',
                'Expected the AND group to be bracketed inside the OR');
        });

        it('REQ-7: shows ne, gt, ge, lt and le as words', () => {
            const one = (op: string) => describeFilter(fetch(`<filter>${cond('tn_score', op, '5')}</filter>`), labels);
            assert.strictEqual(one('ne'), 'Score does not equal 5', 'Expected ne -> "does not equal"');
            assert.strictEqual(one('gt'), 'Score is greater than 5', 'Expected gt -> "is greater than"');
            assert.strictEqual(one('ge'), 'Score is greater than or equal to 5', 'Expected ge -> "is greater than or equal to"');
            assert.strictEqual(one('lt'), 'Score is less than 5', 'Expected lt -> "is less than"');
            assert.strictEqual(one('le'), 'Score is less than or equal to 5', 'Expected le -> "is less than or equal to"');
        });

        it('REQ-7: shows null and not-null as "does not contain data" / "contains data"', () => {
            const one = (op: string) => describeFilter(fetch(`<filter>${cond('fullname', op)}</filter>`), labels);
            assert.strictEqual(one('null'), 'Full Name does not contain data', 'Expected null -> "does not contain data"');
            assert.strictEqual(one('not-null'), 'Full Name contains data', 'Expected not-null -> "contains data"');
        });

        it('REQ-7: shows like with wildcards as contains, begins with and ends with', () => {
            const one = (v: string) => describeFilter(fetch(`<filter>${cond('fullname', 'like', v)}</filter>`), labels);
            assert.strictEqual(one('%smith%'), 'Full Name contains smith', 'Expected %x% -> "contains x"');
            assert.strictEqual(one('smith%'), 'Full Name begins with smith', 'Expected x% -> "begins with x"');
            assert.strictEqual(one('%smith'), 'Full Name ends with smith', 'Expected %x -> "ends with x"');
        });

        it('REQ-7: shows on, on-or-after and on-or-before with the date as written', () => {
            const one = (op: string) => describeFilter(fetch(`<filter>${cond('createdon', op, '2024-01-15')}</filter>`), labels);
            assert.strictEqual(one('on'), 'Created On on 2024-01-15', 'Expected on -> "on <date>"');
            assert.strictEqual(one('on-or-after'), 'Created On on or after 2024-01-15', 'Expected on-or-after -> "on or after <date>"');
            assert.strictEqual(one('on-or-before'), 'Created On on or before 2024-01-15', 'Expected on-or-before -> "on or before <date>"');
        });

        it('REQ-7: shows last-x-days and next-x-days as relative periods', () => {
            const one = (op: string) => describeFilter(fetch(`<filter>${cond('createdon', op, '7')}</filter>`), labels);
            assert.strictEqual(one('last-x-days'), 'Created On in the last 7 days', 'Expected last-x-days -> "in the last 7 days"');
            assert.strictEqual(one('next-x-days'), 'Created On in the next 7 days', 'Expected next-x-days -> "in the next 7 days"');
        });

        it('REQ-7: shows eq-userid as "equals current user"', () => {
            const xml = fetch(`<filter>${cond('ownerid', 'eq-userid')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Owner equals current user', 'Expected eq-userid -> "equals current user"');
        });

        it('REQ-7: lists the values of an in condition as "is one of a, b"', () => {
            const xml = fetch(`<filter><condition attribute="tn_accounttype" operator="in"><value>876080001</value><value>876080002</value></condition></filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Organisation Type is one of Provider, Health Board',
                'Expected both <value>s listed, labelled via the table options (REQ-8)');
        });

        it('REQ-7: falls back to the logical name when no display name is known', () => {
            const xml = fetch(`<filter>${cond('tn_unknown', 'eq', 'x')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'tn_unknown equals x', 'Expected the logical name for an attribute missing from the table');
            assert.strictEqual(describeFilter(fetch(`<filter>${cond('fullname', 'eq', 'x')}</filter>`), noTables), 'fullname equals x',
                'Expected the logical name when there is no table at all');
        });

        it('REQ-7: labels a link-entity filter condition via the linked table', () => {
            const xml = fetch(`${LINK_OPEN}<filter>${cond('name', 'eq', 'Contoso')}</filter></link-entity>`);
            assert.strictEqual(describeFilter(xml, labels), 'Account Name equals Contoso', 'Expected the linked table display name for `name`');
        });

        it('REQ-7: combines the root filter and a link-entity filter with AND', () => {
            const xml = fetch(`<filter>${cond('statecode', 'eq', '0')}</filter>${LINK_OPEN}<filter>${cond('name', 'eq', 'Contoso')}</filter></link-entity>`);
            assert.strictEqual(describeFilter(xml, labels), 'Status equals Active AND Account Name equals Contoso',
                'Expected root conditions then link-entity conditions, joined by AND');
        });

        it('REQ-7: resolves a condition with entityname= against that link-entity\'s table', () => {
            const xml = fetch(`<filter>${cond('name', 'eq', 'Contoso', ' entityname="a_1"')}</filter>${LINK_OPEN}<attribute name="name"/></link-entity>`);
            assert.strictEqual(describeFilter(xml, labels), 'Account Name equals Contoso',
                'Expected entityname="a_1" to be labelled from the account table, not the contact table');
        });

        it('REQ-7: returns undefined for malformed FetchXML instead of throwing', () => {
            for (const bad of ['', 'not xml at all', '<fetch><entity name="contact"><filter type="and"><condition attr']) {
                assert.doesNotThrow(() => describeFilter(bad, labels), `Expected no throw for ${JSON.stringify(bad)}`);
                assert.strictEqual(describeFilter(bad, labels), undefined, `Expected undefined for ${JSON.stringify(bad)}`);
            }
        });
    });

    describe('describeFilter option labels (REQ-8)', () => {
        it('REQ-8: shows the option label when the table file has it', () => {
            const xml = fetch(`<filter>${cond('statecode', 'eq', '0')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Status equals Active', 'Expected "Status equals Active"');
        });

        it('REQ-8: shows the raw number when the table has no labels for that attribute', () => {
            const unlabelled: TableModel = parseTableYaml('entity: contact\nattributes:\n- name: statecode\n  displayName: Status\n').model!;
            const xml = fetch(`<filter>${cond('statecode', 'eq', '0')}</filter>`);
            assert.strictEqual(describeFilter(xml, { table: unlabelled }), 'Status equals 0', 'Expected "Status equals 0" without options');
            assert.strictEqual(describeFilter(fetch(`<filter>${cond('tn_nooptions', 'eq', '5')}</filter>`), labels), 'Unlabelled Choice equals 5',
                'Expected the raw value for a picklist with no inline options');
        });

        it('REQ-8: shows the raw number when the value is not among the labelled options', () => {
            const xml = fetch(`<filter>${cond('statecode', 'eq', '7')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Status equals 7', 'Expected an unknown option value to stay numeric');
        });

        it('REQ-8: labels each value of an in condition independently, raw where unknown', () => {
            const xml = fetch(`<filter><condition attribute="tn_accounttype" operator="in"><value>876080001</value><value>999</value></condition></filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Organisation Type is one of Provider, 999', 'Expected Provider, then the raw 999');
        });

        it('REQ-8: labels option values of a linked-entity condition from the linked table', () => {
            const xml = fetch(`${LINK_OPEN}<filter>${cond('statuscode', 'eq', '1')}</filter></link-entity>`);
            assert.strictEqual(describeFilter(xml, labels), 'Status Reason equals Dormant', 'Expected the account table\'s option label');
        });
    });

    describe('describeFilter unrecognised operators (REQ-9)', () => {
        // Example from the requirement.
        it('REQ-9: shows an unrecognised operator by its raw name', () => {
            const xml = fetch(`<filter>${cond('createdon', 'on-or-after-fiscal-year', '2024')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Created On on-or-after-fiscal-year 2024',
                'Expected "<label> <raw operator> <value>" for an operator the previewer does not know');
        });

        it('REQ-9: shows an unrecognised operator that has no value as "<label> <operator>"', () => {
            const xml = fetch(`<filter>${cond('createdon', 'this-fiscal-year')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Created On this-fiscal-year', 'Expected no trailing value');
        });

        it('REQ-9: never hides the rest of the filter', () => {
            const xml = fetch(`<filter type="and">${cond('statecode', 'eq', '0')}${cond('createdon', 'on-or-after-fiscal-year', '2024')}${cond('fullname', 'like', '%a%')}</filter>`);
            assert.strictEqual(describeFilter(xml, labels), 'Status equals Active AND Created On on-or-after-fiscal-year 2024 AND Full Name contains a',
                'Expected the known conditions on both sides of the unknown one to still appear');
        });
    });

    // ── REQ-10 (mapping part): live rows ───────────────────────────────────────────────────────────────────
    describe('mapRows (REQ-10)', () => {
        const FV = '@OData.Community.Display.V1.FormattedValue';
        const cols = (...names: string[]) => names.map(name => ({ name }));

        it('REQ-10: prefers the formatted value annotation over the raw value', () => {
            const rows = mapRows([{ statecode: 0, [`statecode${FV}`]: 'Active', createdon: '2024-01-15T00:00:00Z', [`createdon${FV}`]: '15/01/2024 00:00' }], cols('statecode', 'createdon'));
            assert.deepStrictEqual(rows, [['Active', '15/01/2024 00:00']], 'Expected the formatted text Dynamics shows, not 0 or the ISO date');
        });

        it('REQ-10: falls back to the raw value, as text, when there is no formatted value', () => {
            const rows = mapRows([{ fullname: 'Ann Smith', tn_score: 7 }], cols('fullname', 'tn_score'));
            assert.deepStrictEqual(rows, [['Ann Smith', '7']], 'Expected raw values converted to strings');
        });

        it('REQ-10: shows a raw zero as "0", not as an empty cell', () => {
            assert.deepStrictEqual(mapRows([{ tn_score: 0 }], cols('tn_score')), [['0']], 'Expected 0 to render as "0"');
        });

        it('REQ-10: reads a lookup column from `_<name>_value` using its formatted value', () => {
            const rows = mapRows([{ _primarycontactid_value: '11111111-1111-1111-1111-111111111111', [`_primarycontactid_value${FV}`]: 'Bob Jones' }], cols('primarycontactid'));
            assert.deepStrictEqual(rows, [['Bob Jones']], 'Expected the lookup\'s display name, not the GUID');
        });

        it('REQ-10: reads a linked-entity column from `alias.attribute`', () => {
            const rows = mapRows([{ 'a_1.name': 'Contoso' }], cols('a_1.name'));
            assert.deepStrictEqual(rows, [['Contoso']], 'Expected the value under the "a_1.name" key');
        });

        it('REQ-10: prefers the formatted value for a linked-entity column too', () => {
            const rows = mapRows([{ 'a_1.statuscode': 1, [`a_1.statuscode${FV}`]: 'Dormant' }], cols('a_1.statuscode'));
            assert.deepStrictEqual(rows, [['Dormant']], 'Expected the formatted value under "a_1.statuscode@..."');
        });

        it('REQ-10: renders missing and null values as an empty string', () => {
            const rows = mapRows([{ fullname: null }, {}], cols('fullname', 'telephone1'));
            assert.deepStrictEqual(rows, [['', ''], ['', '']], 'Expected "" for null, absent and unrequested values');
        });

        it('REQ-10: orders cells by layout column order and ignores other properties', () => {
            const rows = mapRows([{ contactid: 'x', '@odata.etag': 'W/"1"', telephone1: '0123', fullname: 'Ann' }], cols('fullname', 'telephone1'));
            assert.deepStrictEqual(rows, [['Ann', '0123']], 'Expected [fullname, telephone1] only, in column order');
        });

        it('REQ-10: returns one row per record, in record order, and [] for no records', () => {
            assert.deepStrictEqual(mapRows([{ fullname: 'A' }, { fullname: 'B' }], cols('fullname')), [['A'], ['B']], 'Expected one row per record in order');
            assert.deepStrictEqual(mapRows([], cols('fullname')), [], 'Expected [] when there are no records');
        });
    });
});

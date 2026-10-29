import * as assert from 'assert';
import { limitFetchXml } from '../../src/dataverseClient';
import { FormControl, parseFormYaml, parseTableYaml, TableAttribute } from '../../src/form/formModel';
import {
    buildLookupSearchFetch, buildRecordFetch, buildRelatedFetch, escapeLikeValue, fieldDisplay, formFieldNames,
    lookupResultColumns, mapLookupResult, PrimaryAttributes, quickViewRecordRef, recordStatus, recordTitle,
    RelationshipInfo,
} from '../../src/form/recordPreview';

/**
 * Pure logic behind the form previewer's live record selector ("pick a record, the form fills with its values").
 * Production module: src/form/recordPreview.ts (no `vscode` import). Read-only: nothing here writes to Dataverse.
 *
 * Out of scope here (needs the webview / HTTP): the lookup control, debounce, recents, panel wiring, styling.
 * Primary id / name are NOT in the exported table YAML, so callers pass them in (from live EntityDefinitions metadata).
 */

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const LOGICAL_NAME = '@Microsoft.Dynamics.CRM.lookuplogicalname';

const GUID = '801A405F-EB04-EC11-B6E6-000D3A86BC77';
const GUID_LOWER = GUID.toLowerCase();
const OTHER_GUID = '0d1e47ff-12b2-4f53-9090-bee951b98cb4';

/** The deliberate non-GUID guard must throw an error that says why (its message mentions the GUID), not any failure. */
const GUID_ERROR = (e: unknown): boolean => e instanceof Error && /guid/i.test(e.message);

const contactPrimary: PrimaryAttributes = { id: 'contactid', name: 'fullname' };

// ── Tiny strict FetchXML reader (test-only) ──────────────────────────────────
// Lets the tests assert on query *structure* (which filter a condition sits in) without caring how it was built,
// and proves that hostile input leaves the query well-formed XML.

interface El {
    name: string;
    attrs: Record<string, string>;
    /** Ancestors, outermost first (excludes this element). */
    ancestors: El[];
}

const decodeXml = (s: string): string => s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const ATTR_VALUE = '(?:[^"<&]|&(?:amp|lt|gt|quot|apos|#\\d+|#x[0-9a-fA-F]+);)*';
const TAG = new RegExp(`<(\\/?)([A-Za-z][\\w-]*)((?:\\s+[\\w:-]+="${ATTR_VALUE}")*)\\s*(\\/?)>`, 'g');

/** Parses strictly: throws if anything is not a well-formed tag, or tags are unbalanced. Returns every element in document order. */
function readFetch(xml: string): El[] {
    const elements: El[] = [];
    const stack: El[] = [];
    let last = 0;
    for (const m of xml.matchAll(TAG)) {
        const between = xml.slice(last, m.index);
        assert.strictEqual(between.trim(), '', `FetchXML has stray text or an unescaped character outside a tag: ${JSON.stringify(between)} in ${xml}`);
        last = (m.index ?? 0) + m[0].length;
        const [, closing, name, rawAttrs, selfClosing] = m;
        if (closing) {
            const top = stack.pop();
            assert.strictEqual(top?.name, name, `FetchXML closes <${name}> but <${top?.name}> is open: ${xml}`);
            continue;
        }
        const attrs: Record<string, string> = {};
        for (const a of rawAttrs.matchAll(/([\w:-]+)="([^"]*)"/g)) { attrs[a[1]] = decodeXml(a[2]); }
        const el: El = { name, attrs, ancestors: [...stack] };
        elements.push(el);
        if (!selfClosing) { stack.push(el); }
    }
    assert.strictEqual(xml.slice(last).trim(), '', `FetchXML has trailing stray text: ${xml}`);
    assert.strictEqual(stack.length, 0, `FetchXML has unclosed elements (${stack.map(s => s.name).join(', ')}): ${xml}`);
    assert.ok(elements.length > 0, `Expected FetchXML but got: ${JSON.stringify(xml)}`);
    return elements;
}

const conditions = (xml: string): El[] => readFetch(xml).filter(e => e.name === 'condition');
const inside = (el: El, name: string, predicate: (e: El) => boolean = () => true): boolean =>
    el.ancestors.some(a => a.name === name && predicate(a));
const insideOrFilter = (el: El): boolean => inside(el, 'filter', f => f.attrs.type === 'or');
const rootAttributes = (xml: string): string[] => {
    // `<attribute>` elements that belong to the root entity (not a link-entity).
    return readFetch(xml).filter(e => e.name === 'attribute' && !inside(e, 'link-entity')).map(e => e.attrs.name);
};
const fetchRoot = (xml: string): El => readFetch(xml).find(e => e.name === 'fetch')!;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Verbatim FetchXML of the QAD "Quick Find Active Contacts" view (d365-architect/qad/contact). */
const CONTACT_QUICK_FIND = '<fetch version="1.0" output-format="xml-platform" mapping="logical" savedqueryid="8df19b44-a073-40c3-9d6d-ee1355d8c4ba"><entity name="contact"><attribute name="fullname" /><attribute name="parentcustomerid" /><attribute name="address1_city" /><attribute name="address1_telephone1" /><attribute name="telephone1" /><attribute name="emailaddress1" /><attribute name="contactid" /><order attribute="fullname" descending="false" /><filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter><filter type="or" isquickfindfields="1"><condition attribute="fullname" operator="like" value="{0}" /><condition attribute="firstname" operator="like" value="{0}" /><condition attribute="lastname" operator="like" value="{0}" /><condition attribute="middlename" operator="like" value="{0}" /><condition attribute="emailaddress1" operator="like" value="{0}" /><condition attribute="parentcustomerid" operator="like" value="{0}" /><condition attribute="telephone1" operator="like" value="{0}" /><condition attribute="mobilephone" operator="like" value="{0}" /><condition attribute="tn_referencenumber" operator="like" value="{0}" /></filter><attribute name="tn_jobtitle" /><attribute name="tn_referencenumber" /></entity></fetch>';
const QUICK_FIND_COLUMNS = ['fullname', 'firstname', 'lastname', 'middlename', 'emailaddress1', 'parentcustomerid', 'telephone1', 'mobilephone', 'tn_referencenumber'];

const RESULT_COLUMNS = ['fullname', 'emailaddress1', 'parentcustomerid'];

/** A subgrid view on contact, as shown on an account form. */
const SUBGRID_FETCH = '<fetch version="1.0" mapping="logical"><entity name="contact"><attribute name="fullname" /><attribute name="contactid" /><order attribute="fullname" descending="false" /><filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter><link-entity alias="a_1" name="account" to="parentcustomerid" from="accountid" link-type="outer"><attribute name="name" /></link-entity></entity></fetch>';
const SUBGRID_FETCH_OR = '<fetch version="1.0" mapping="logical"><entity name="contact"><attribute name="fullname" /><filter type="or"><condition attribute="tn_flag" operator="eq" value="1" /><condition attribute="tn_other" operator="eq" value="2" /></filter></entity></fetch>';
const SUBGRID_FETCH_NO_FILTER = '<fetch version="1.0"><entity name="contact"><attribute name="fullname" /></entity></fetch>';

const oneToMany: RelationshipInfo = { kind: 'OneToMany', referencingAttribute: 'parentcustomerid' };
const manyToMany: RelationshipInfo = {
    kind: 'ManyToMany',
    intersectEntity: 'tn_account_contact',
    thisEntityIntersectAttribute: 'accountid',
    otherEntityIntersectAttribute: 'contactid',
    otherEntityPrimaryId: 'contactid',
};

const attr = (name: string, type: string, extra: Partial<TableAttribute> = {}): TableAttribute => ({ name, type, ...extra });

describe('record preview (live record selector)', () => {
    // ── REQ-3 / REQ-5: escaping ─────────────────────────────────────────────
    describe('escapeLikeValue', () => {
        // REQ-5: `%`, `_` and `[` must match literally in a LIKE pattern; escapeLikeValue is in src/form/recordPreview.ts.
        it('REQ-5: wraps % in brackets so it matches a literal percent sign', () => {
            assert.strictEqual(escapeLikeValue('100%'), '100[%]', 'Expected "%" to be escaped as "[%]"');
        });

        it('REQ-5: wraps _ in brackets so it matches a literal underscore', () => {
            assert.strictEqual(escapeLikeValue('a_b'), 'a[_]b', 'Expected "_" to be escaped as "[_]"');
        });

        it('REQ-5: escapes [ as [[] so it matches a literal bracket', () => {
            assert.strictEqual(escapeLikeValue('a[b'), 'a[[]b', 'Expected "[" to be escaped as "[[]"');
        });

        it('REQ-5: escapes the bracket first so characters it adds are not escaped twice', () => {
            assert.strictEqual(escapeLikeValue('[%]'), '[[][%]]', 'Expected "[%]" (a literal bracketed percent) to become "[[][%]]"');
        });

        it('REQ-5: leaves ordinary text, quotes, angle brackets, ampersands and "]]>" to the XML layer', () => {
            assert.strictEqual(escapeLikeValue(`Jane O'Neil <"&> ]]>`), `Jane O'Neil <"&> ]]>`, 'Expected LIKE escaping to touch only % _ [');
            assert.strictEqual(escapeLikeValue(''), '', 'Expected an empty string to stay empty');
        });
    });

    // ── REQ-3 / REQ-5: search query ─────────────────────────────────────────
    describe('buildLookupSearchFetch', () => {
        const build = (text: string, quickFind: string | undefined = CONTACT_QUICK_FIND, top?: number) =>
            buildLookupSearchFetch('contact', quickFind, RESULT_COLUMNS, text, contactPrimary, top);
        const likeConditions = (xml: string) => conditions(xml).filter(c => c.attrs.operator === 'like');

        // Given the contact Quick Find view, typing "smith" searches every Quick Find column for text containing "smith".
        it('REQ-3: searches every Quick Find column with contains semantics (like %text%)', () => {
            const likes = likeConditions(build('smith'));
            assert.deepStrictEqual(likes.map(c => c.attrs.attribute).sort(), [...QUICK_FIND_COLUMNS].sort(),
                'Expected one like condition per Quick Find search column (the conditions in the isquickfindfields filter)');
            for (const c of likes) {
                assert.strictEqual(c.attrs.value, '%smith%', `Expected a contains pattern for ${c.attrs.attribute}, got ${c.attrs.value}`);
            }
        });

        it('REQ-3: ORs the search columns together so a match on any one column returns the record', () => {
            for (const c of likeConditions(build('smith'))) {
                assert.ok(insideOrFilter(c), `Expected the ${c.attrs.attribute} search condition to sit inside an OR filter`);
            }
        });

        it('REQ-3: keeps the Quick Find view\'s other filters (statecode = Active) and ANDs them with the search', () => {
            const state = conditions(build('smith')).find(c => c.attrs.attribute === 'statecode');
            assert.ok(state, 'Expected the Quick Find view\'s statecode condition to be kept');
            assert.strictEqual(state!.attrs.operator, 'eq');
            assert.strictEqual(state!.attrs.value, '0');
            assert.ok(!insideOrFilter(state!), 'Expected statecode to be ANDed with the search, not inside the OR group');
        });

        it('REQ-3: leaves no {0} placeholder in the query', () => {
            assert.ok(!build('smith').includes('{0}'), 'Expected the {0} search placeholder to be replaced with the search text');
        });

        it('REQ-3: shows up to 10 matches by default', () => {
            const root = fetchRoot(build('smith'));
            assert.ok(root.attrs.top === '10' || root.attrs.count === '10', `Expected top="10" on <fetch>, got ${JSON.stringify(root.attrs)}`);
        });

        it('REQ-3: honours an explicit top', () => {
            assert.strictEqual(fetchRoot(build('smith', CONTACT_QUICK_FIND, 5)).attrs.top, '5', 'Expected top="5" when asked for 5 results');
        });

        // REQ-4: the query must return the Lookup View columns plus the id so a result can be selected.
        it('REQ-4: selects the result columns and the primary id, and nothing else from the Quick Find view', () => {
            assert.deepStrictEqual(rootAttributes(build('smith')).sort(), ['contactid', ...RESULT_COLUMNS].sort(),
                'Expected exactly the lookup result columns plus the primary id (not the Quick Find view\'s own columns)');
        });

        it('REQ-4: does not select the primary id twice when it is already a result column', () => {
            const xml = buildLookupSearchFetch('contact', CONTACT_QUICK_FIND, ['fullname', 'contactid'], 'x', contactPrimary);
            assert.deepStrictEqual(rootAttributes(xml).sort(), ['contactid', 'fullname'], 'Expected each attribute to be selected once');
        });

        // No Quick Find view exported: search the primary name column instead.
        it('REQ-3: falls back to a contains search on the primary name column when there is no Quick Find view', () => {
            const likes = likeConditions(buildLookupSearchFetch('contact', undefined, RESULT_COLUMNS, 'smith', contactPrimary));
            assert.deepStrictEqual(likes.map(c => [c.attrs.attribute, c.attrs.value]), [['fullname', '%smith%']],
                'Expected a single like %smith% condition on the primary name column (fullname)');
        });

        it('REQ-3: falls back to the primary name when the view has no isquickfindfields filter', () => {
            const noFindFields = '<fetch><entity name="contact"><attribute name="fullname"/><filter type="and"><condition attribute="statecode" operator="eq" value="0"/></filter></entity></fetch>';
            const likes = likeConditions(build('smith', noFindFields));
            assert.deepStrictEqual(likes.map(c => c.attrs.attribute), ['fullname'], 'Expected the primary name column to be searched');
        });

        it('REQ-3: never lets a Quick Find numeric placeholder ({1}) reach the query', () => {
            const withNumeric = CONTACT_QUICK_FIND.replace('</filter><attribute name="tn_jobtitle"', '<condition attribute="tn_score" operator="eq" value="{1}" /></filter><attribute name="tn_jobtitle"');
            const xml = build('smith', withNumeric);
            assert.ok(!/\{\d\}/.test(xml), `Expected no {n} placeholder in the query, got: ${xml}`);
            assert.ok(likeConditions(xml).length > 0, 'Expected the text columns to still be searched');
        });

        it('REQ-3: trims surrounding whitespace from the search text', () => {
            assert.strictEqual(likeConditions(build('  smith ')).every(c => c.attrs.value === '%smith%'), true,
                'Expected "  smith " to search for %smith%');
        });

        it('REQ-3: an empty search adds no like condition but still returns the first matches of the view', () => {
            const xml = build('   ');
            assert.strictEqual(likeConditions(xml).length, 0, 'Expected no like conditions for blank search text');
            assert.ok(conditions(xml).some(c => c.attrs.attribute === 'statecode'), 'Expected the Active filter to still apply');
        });

        // Malformed quick find FetchXML must not throw: the preview re-runs on every pause in typing.
        for (const bad of ['', 'not xml at all', '<fetch><entity name="contact"', '<fetch><entity name="contact"><filter isquickfindfields="1"><condition', '<<>>']) {
            it(`REQ-3: malformed Quick Find FetchXML ${JSON.stringify(bad)} does not throw and falls back to the primary name`, () => {
                let xml = '';
                assert.doesNotThrow(() => { xml = build('smith', bad); }, 'Expected malformed Quick Find FetchXML to be tolerated');
                assert.deepStrictEqual(likeConditions(xml).map(c => c.attrs.attribute), ['fullname'],
                    'Expected a fallback search on the primary name column');
            });
        }

        // REQ-5: search text is data, never query syntax. Every hostile value must round-trip as a literal and leave the query well-formed.
        const hostile: Array<[string, string]> = [
            ['closing a value and injecting a condition', '"/><condition attribute="x" operator="eq" value="1'],
            ['the spec example <"&', '<"&'],
            ['a lone percent sign', '%'],
            ['an underscore', 'a_b'],
            ['an open bracket', '[abc'],
            ['a CDATA terminator', ']]>'],
            ['an entity lookalike (must not be double-decoded)', '&lt;script&gt;&amp;'],
            ['single quotes', "O'Neil' OR '1'='1"],
            ['a closing fetch tag', '</filter></entity></fetch><fetch><entity name="systemuser">'],
            ['a placeholder', '{0}'],
            ['JavaScript replacement patterns', '$& $1 $$'],
        ];
        for (const [what, text] of hostile) {
            it(`REQ-5: treats ${what} (${JSON.stringify(text)}) as literal search text and keeps the query well-formed`, () => {
                const xml = build(text);
                const likes = likeConditions(xml);
                assert.strictEqual(likes.length, QUICK_FIND_COLUMNS.length,
                    'Expected search text to add no extra conditions and not remove any (it was parsed as query syntax)');
                for (const c of likes) {
                    assert.strictEqual(c.attrs.value, `%${escapeLikeValue(text)}%`,
                        `Expected ${c.attrs.attribute} to search the literal text, got ${c.attrs.value}`);
                }
                assert.ok(!conditions(xml).some(c => c.attrs.attribute === 'x'), 'Expected no injected condition on attribute "x"');
                assert.ok(!readFetch(xml).some(e => e.name === 'systemuser' || (e.name === 'entity' && e.attrs.name !== 'contact')),
                    'Expected the query to still target only the contact entity');
            });
        }

        it('REQ-5: the percent sign is searched literally (%[%]%), not as a wildcard', () => {
            const value = likeConditions(build('%'))[0].attrs.value;
            assert.strictEqual(value, '%[%]%', 'Expected typing "%" to search for a literal percent sign');
        });

        it('REQ-5: the primary-name fallback also escapes hostile text', () => {
            const xml = buildLookupSearchFetch('contact', undefined, RESULT_COLUMNS, '"/><condition attribute="x"', contactPrimary);
            assert.deepStrictEqual(likeConditions(xml).map(c => c.attrs.value), ['%"/><condition attribute="x"%'],
                'Expected the fallback search to carry the hostile text as a single literal value');
        });
    });

    // ── REQ-4: lookup results ───────────────────────────────────────────────
    describe('lookupResultColumns', () => {
        const col = (name: string): ViewColumnLike => ({ name });
        type ViewColumnLike = { name: string; width?: number };

        it('REQ-4: puts the primary name first, then the next two Lookup View columns', () => {
            const cols = lookupResultColumns([col('fullname'), col('emailaddress1'), col('parentcustomerid'), col('telephone1')], 'fullname');
            assert.deepStrictEqual(cols, ['fullname', 'emailaddress1', 'parentcustomerid'], 'Expected primary name plus two more columns (three lines)');
        });

        it('REQ-4: puts the primary name first even when the Lookup View lists it later, without repeating it', () => {
            const cols = lookupResultColumns([col('emailaddress1'), col('fullname'), col('telephone1')], 'fullname');
            assert.deepStrictEqual(cols, ['fullname', 'emailaddress1', 'telephone1'], 'Expected the primary name first and not repeated');
        });

        it('REQ-4: returns just the primary name when there is no Lookup View', () => {
            assert.deepStrictEqual(lookupResultColumns(undefined, 'fullname'), ['fullname'], 'Expected only the primary name without a Lookup View');
            assert.deepStrictEqual(lookupResultColumns([], 'fullname'), ['fullname'], 'Expected only the primary name for an empty Lookup View');
        });

        it('REQ-4: skips linked-entity columns (alias.attribute), which a single-table search cannot select', () => {
            const cols = lookupResultColumns([col('fullname'), col('a_1.name'), col('emailaddress1')], 'fullname');
            assert.deepStrictEqual(cols, ['fullname', 'emailaddress1'], 'Expected alias.attribute columns to be left out');
        });
    });

    describe('mapLookupResult', () => {
        const jane: Record<string, unknown> = {
            contactid: GUID_LOWER,
            fullname: 'Jane Smith',
            emailaddress1: 'jane@contoso.com',
            [`_parentcustomerid_value`]: OTHER_GUID,
            [`_parentcustomerid_value${FORMATTED}`]: 'Contoso Ltd',
        };

        // Example from REQ-4: "Jane Smith" / "jane@contoso.com" / "Contoso Ltd".
        it('REQ-4: shows the primary name first and the other columns underneath (Jane Smith / jane@contoso.com / Contoso Ltd)', () => {
            assert.deepStrictEqual(mapLookupResult(jane, RESULT_COLUMNS, 'contactid'), {
                id: GUID_LOWER, primary: 'Jane Smith', secondary: ['jane@contoso.com', 'Contoso Ltd'],
            }, 'Expected id, primary line and two secondary lines (the lookup shown by its name, not its GUID)');
        });

        it('REQ-4: drops secondary lines that are empty', () => {
            const sparse = { contactid: GUID_LOWER, fullname: 'Jane Smith', emailaddress1: null, [`_parentcustomerid_value${FORMATTED}`]: 'Contoso Ltd' };
            assert.deepStrictEqual(mapLookupResult(sparse, RESULT_COLUMNS, 'contactid').secondary, ['Contoso Ltd'],
                'Expected the null email line to be omitted');
        });

        it('REQ-4: prefers the formatted value over the raw one', () => {
            const rec = { contactid: GUID_LOWER, fullname: 'Jane Smith', tn_type: 876080001, [`tn_type${FORMATTED}`]: 'Provider' };
            assert.deepStrictEqual(mapLookupResult(rec, ['fullname', 'tn_type'], 'contactid').secondary, ['Provider'],
                'Expected the choice label, not 876080001');
        });

        it('REQ-4: returns an empty secondary list when only the primary column is shown', () => {
            assert.deepStrictEqual(mapLookupResult(jane, ['fullname'], 'contactid'), { id: GUID_LOWER, primary: 'Jane Smith', secondary: [] });
        });
    });

    // ── REQ-7: field values ─────────────────────────────────────────────────
    describe('fieldDisplay', () => {
        it('REQ-7: shows a lookup as a link carrying the related record\'s name', () => {
            const rec = { _parentcustomerid_value: OTHER_GUID, [`_parentcustomerid_value${FORMATTED}`]: 'Contoso Ltd' };
            assert.deepStrictEqual(fieldDisplay(rec, 'parentcustomerid', attr('parentcustomerid', 'Customer')), { text: 'Contoso Ltd', kind: 'link' },
                'Expected the lookup name (not the GUID) as a link');
        });

        it('REQ-7: detects a lookup from its _x_value key even when the table attribute is unknown', () => {
            const rec = { _ownerid_value: OTHER_GUID, [`_ownerid_value${FORMATTED}`]: 'Joshua Cottrell' };
            assert.deepStrictEqual(fieldDisplay(rec, 'ownerid'), { text: 'Joshua Cottrell', kind: 'link' }, 'Expected an owner lookup to render as a link');
        });

        it('REQ-7: shows a choice as its label', () => {
            const rec = { statecode: 0, [`statecode${FORMATTED}`]: 'Active' };
            assert.deepStrictEqual(fieldDisplay(rec, 'statecode', attr('statecode', 'State')), { text: 'Active', kind: 'text' }, 'Expected "Active", not 0');
        });

        it('REQ-7: falls back to the table\'s option label when the record has no formatted value for a choice', () => {
            const options = new Map([[876080001, 'Provider'], [876080002, 'Health Board']]);
            const rec = { tn_accounttype: 876080002 };
            assert.deepStrictEqual(fieldDisplay(rec, 'tn_accounttype', attr('tn_accounttype', 'Picklist', { options })), { text: 'Health Board', kind: 'text' },
                'Expected the label from the table\'s options');
        });

        it('REQ-7: shows a Yes/No column as Yes or No', () => {
            const yes = { tn_createdfromportal: true, [`tn_createdfromportal${FORMATTED}`]: 'Yes' };
            assert.strictEqual(fieldDisplay(yes, 'tn_createdfromportal', attr('tn_createdfromportal', 'Boolean')).text, 'Yes', 'Expected "Yes" for true');
            const no = { tn_createdfromportal: false, [`tn_createdfromportal${FORMATTED}`]: 'No' };
            assert.deepStrictEqual(fieldDisplay(no, 'tn_createdfromportal', attr('tn_createdfromportal', 'Boolean')), { text: 'No', kind: 'text' },
                'Expected "No" for false: a false value is not an empty value');
        });

        it('REQ-7: shows a raw false Yes/No value as "No" when there is no formatted annotation', () => {
            assert.deepStrictEqual(fieldDisplay({ tn_createdfromportal: false }, 'tn_createdfromportal', attr('tn_createdfromportal', 'Boolean')),
                { text: 'No', kind: 'text' }, 'Expected a raw false on a Boolean column to read "No", not "---"');
        });

        it('REQ-7: shows a raw true Yes/No value as "Yes" when there is no formatted annotation', () => {
            assert.strictEqual(fieldDisplay({ tn_createdfromportal: true }, 'tn_createdfromportal', attr('tn_createdfromportal', 'Boolean')).text, 'Yes');
        });

        it('REQ-7: shows a date as Dynamics formats it, not the ISO value', () => {
            const rec = { tn_enddate: '2026-10-29T00:00:00Z', [`tn_enddate${FORMATTED}`]: '29/10/2026' };
            assert.deepStrictEqual(fieldDisplay(rec, 'tn_enddate', attr('tn_enddate', 'DateTime')), { text: '29/10/2026', kind: 'text' },
                'Expected the formatted date');
        });

        it('REQ-7: shows money as Dynamics formats it', () => {
            const rec = { tn_budget: 1250, [`tn_budget${FORMATTED}`]: '£1,250.00' };
            assert.deepStrictEqual(fieldDisplay(rec, 'tn_budget', attr('tn_budget', 'Money')), { text: '£1,250.00', kind: 'text' }, 'Expected the currency-formatted amount');
        });

        it('REQ-7: shows a number as Dynamics formats it', () => {
            const rec = { tn_score: 1234, [`tn_score${FORMATTED}`]: '1,234' };
            assert.strictEqual(fieldDisplay(rec, 'tn_score', attr('tn_score', 'Integer')).text, '1,234', 'Expected the formatted number');
        });

        it('REQ-7: shows a plain text value as it is', () => {
            assert.deepStrictEqual(fieldDisplay({ emailaddress1: 'jane@contoso.com' }, 'emailaddress1', attr('emailaddress1', 'String')),
                { text: 'jane@contoso.com', kind: 'text' });
        });

        it('REQ-7: treats a raw 0 as a value, not as empty', () => {
            assert.deepStrictEqual(fieldDisplay({ tn_score: 0 }, 'tn_score', attr('tn_score', 'Integer')), { text: '0', kind: 'text' },
                'Expected 0 to be shown as "0"');
        });

        it('REQ-7: treats a raw false as a value even when the attribute is unknown', () => {
            assert.notStrictEqual(fieldDisplay({ tn_flag: false }, 'tn_flag').kind, 'empty', 'Expected false not to be shown as "---"');
        });

        // Empty values show "---".
        for (const [what, rec] of [
            ['missing from the record', {}],
            ['null', { tn_note: null }],
            ['an empty string', { tn_note: '' }],
            ['a null lookup', { _parentcustomerid_value: null }],
        ] as Array<[string, Record<string, unknown>]>) {
            it(`REQ-7: shows "---" (empty) when the value is ${what}`, () => {
                const attribute = what === 'a null lookup' ? 'parentcustomerid' : 'tn_note';
                assert.deepStrictEqual(fieldDisplay(rec, attribute), { text: '---', kind: 'empty' }, `Expected "---" for a value that is ${what}`);
            });
        }
    });

    // ── REQ-8: title and status ─────────────────────────────────────────────
    describe('recordTitle / recordStatus', () => {
        it('REQ-8: the form title is the record\'s primary name', () => {
            assert.strictEqual(recordTitle({ fullname: 'Jane Smith', contactid: GUID_LOWER }, 'fullname'), 'Jane Smith', 'Expected the primary name column as the title');
        });

        it('REQ-8: the status reads "<state> - Saved" using the formatted state label', () => {
            assert.strictEqual(recordStatus({ statecode: 0, [`statecode${FORMATTED}`]: 'Active' }), 'Active - Saved', 'Expected "Active - Saved"');
            assert.strictEqual(recordStatus({ statecode: 1, [`statecode${FORMATTED}`]: 'Inactive' }), 'Inactive - Saved', 'Expected "Inactive - Saved"');
        });

        it('REQ-8: the status is empty when the record has no statecode', () => {
            assert.strictEqual(recordStatus({ fullname: 'Jane Smith' }), '', 'Expected no status text without a statecode');
        });
    });

    // ── REQ-9: subgrid rows ─────────────────────────────────────────────────
    describe('buildRelatedFetch', () => {
        const idCondition = (xml: string, attribute: string) =>
            conditions(xml).filter(c => c.attrs.attribute === attribute && c.attrs.operator === 'eq' && c.attrs.value === GUID_LOWER);

        describe('one-to-many', () => {
            it('REQ-9: filters the subgrid view to rows that point at this record, with the id normalised (no braces, lower-case)', () => {
                const xml = buildRelatedFetch(SUBGRID_FETCH, oneToMany, `{${GUID}}`);
                assert.strictEqual(idCondition(xml, 'parentcustomerid').length, 1,
                    'Expected exactly one parentcustomerid eq <lower-case guid> condition');
            });

            it('REQ-9: ANDs the record filter with the view\'s existing filters, which are kept', () => {
                const xml = buildRelatedFetch(SUBGRID_FETCH, oneToMany, GUID);
                const mine = idCondition(xml, 'parentcustomerid')[0];
                assert.ok(!insideOrFilter(mine), 'Expected the record filter to sit outside any OR group');
                assert.ok(!inside(mine, 'link-entity'), 'Expected the record filter to apply to the root entity, not a link-entity');
                const state = conditions(xml).find(c => c.attrs.attribute === 'statecode');
                assert.ok(state, 'Expected the view\'s statecode filter to be kept');
                assert.strictEqual(state!.attrs.value, '0');
            });

            it('REQ-9: is not absorbed into a root OR filter (the row must match this record AND the OR group)', () => {
                const xml = buildRelatedFetch(SUBGRID_FETCH_OR, oneToMany, GUID);
                const mine = idCondition(xml, 'parentcustomerid')[0];
                assert.ok(mine, 'Expected the record filter to be added');
                assert.ok(!insideOrFilter(mine), 'Expected the record filter outside the existing OR group');
                const orConditions = conditions(xml).filter(c => c.attrs.attribute === 'tn_flag' || c.attrs.attribute === 'tn_other');
                assert.strictEqual(orConditions.length, 2, 'Expected both original OR conditions to be kept');
                assert.ok(orConditions.every(insideOrFilter), 'Expected the original conditions to stay in their OR group');
            });

            it('REQ-9: adds the record filter to a view that has no filter', () => {
                const xml = buildRelatedFetch(SUBGRID_FETCH_NO_FILTER, oneToMany, GUID);
                assert.strictEqual(idCondition(xml, 'parentcustomerid').length, 1, 'Expected the record filter to be added');
                assert.ok(rootAttributes(xml).includes('fullname'), 'Expected the view\'s columns to be kept');
            });

            it('REQ-9: keeps the view\'s columns, sort order and link-entities', () => {
                const els = readFetch(buildRelatedFetch(SUBGRID_FETCH, oneToMany, GUID));
                assert.ok(els.some(e => e.name === 'order' && e.attrs.attribute === 'fullname'), 'Expected the sort order to be kept');
                assert.ok(els.some(e => e.name === 'link-entity' && e.attrs.alias === 'a_1'), 'Expected the view\'s link-entity to be kept');
                assert.ok(els.some(e => e.name === 'attribute' && e.attrs.name === 'name' && inside(e, 'link-entity')), 'Expected linked columns to be kept');
            });

            it('REQ-9: the related query stays a single well-formed fetch that the 50-row limit can be applied to', () => {
                const withTop = SUBGRID_FETCH.replace('<fetch version="1.0"', '<fetch top="200" version="1.0"');
                const limited = limitFetchXml(buildRelatedFetch(withTop, oneToMany, GUID), 50);
                const root = fetchRoot(limited);
                assert.strictEqual(root.attrs.count, '50', `Expected up to 50 rows per subgrid, got ${JSON.stringify(root.attrs)}`);
            });
        });

        describe('many-to-many', () => {
            const links = (xml: string) => readFetch(xml).filter(e => e.name === 'link-entity');

            it('REQ-9: joins through the intersect table with an inner link on the other table\'s primary id', () => {
                const link = links(buildRelatedFetch(SUBGRID_FETCH, manyToMany, GUID)).find(l => l.attrs.name === 'tn_account_contact');
                assert.ok(link, 'Expected a link-entity on the intersect table tn_account_contact');
                assert.strictEqual(link!.attrs.from, 'contactid', 'Expected from= the intersect column pointing at the displayed rows');
                assert.strictEqual(link!.attrs.to, 'contactid', 'Expected to= the displayed table\'s primary id');
                assert.ok(link!.attrs['link-type'] === undefined || link!.attrs['link-type'] === 'inner', 'Expected an inner join so unrelated rows are excluded');
            });

            it('REQ-9: filters the intersect table to this record, with the id normalised', () => {
                const xml = buildRelatedFetch(SUBGRID_FETCH, manyToMany, `{${GUID}}`);
                const mine = idCondition(xml, 'accountid');
                assert.strictEqual(mine.length, 1, 'Expected exactly one accountid eq <lower-case guid> condition');
                assert.ok(inside(mine[0], 'link-entity', l => l.attrs.name === 'tn_account_contact'),
                    'Expected the record filter to sit inside the intersect link-entity');
                assert.ok(!insideOrFilter(mine[0]), 'Expected the record filter outside any OR group');
            });

            it('REQ-9: keeps the view\'s own filters, columns and link-entities, and does not reuse an existing alias', () => {
                const xml = buildRelatedFetch(SUBGRID_FETCH, manyToMany, GUID);
                assert.ok(conditions(xml).some(c => c.attrs.attribute === 'statecode'), 'Expected the view\'s statecode filter to be kept');
                assert.ok(rootAttributes(xml).includes('fullname'), 'Expected the view\'s columns to be kept');
                const all = links(xml);
                assert.ok(all.some(l => l.attrs.alias === 'a_1'), 'Expected the existing a_1 link-entity to be kept');
                const aliases = all.map(l => l.attrs.alias).filter(Boolean);
                assert.strictEqual(new Set(aliases).size, aliases.length, `Expected unique link-entity aliases, got ${aliases.join(', ')}`);
            });

            it('REQ-9: adds the intersect join to a view with no filter or link-entity', () => {
                const xml = buildRelatedFetch(SUBGRID_FETCH_NO_FILTER, manyToMany, GUID);
                assert.strictEqual(idCondition(xml, 'accountid').length, 1, 'Expected the record filter to be added');
            });
        });

        describe('record id guard', () => {
            const bad = ['', 'abc', '801A405F-EB04-EC11-B6E6', `${GUID}x`, '"/><condition attribute="x"', "1' OR '1'='1", '{}'];
            for (const id of bad) {
                for (const rel of [oneToMany, manyToMany]) {
                    it(`REQ-9: refuses ${JSON.stringify(id)} as a record id (${rel.kind}) instead of putting it in the query`, () => {
                        assert.throws(() => buildRelatedFetch(SUBGRID_FETCH, rel, id), GUID_ERROR, 'Expected a non-GUID record id to throw');
                    });
                }
            }

            it('REQ-9: accepts an upper-case braced GUID, a bare GUID and a lower-case GUID', () => {
                for (const id of [`{${GUID}}`, GUID, GUID_LOWER]) {
                    assert.doesNotThrow(() => buildRelatedFetch(SUBGRID_FETCH, oneToMany, id), `Expected ${id} to be accepted`);
                }
            });
        });

        describe('malformed subgrid FetchXML', () => {
            for (const bad of ['', 'not xml', '<fetch>', '<fetch><entity name="contact"', '<<>>', '<fetch/>']) {
                for (const rel of [oneToMany, manyToMany]) {
                    it(`REQ-9: ${JSON.stringify(bad)} (${rel.kind}) does not throw`, () => {
                        assert.doesNotThrow(() => buildRelatedFetch(bad, rel, GUID), 'Expected malformed FetchXML to be tolerated (only a bad record id throws)');
                    });
                }
            }
        });
    });

    // ── Reading the record itself (supports REQ-7 / REQ-8 / REQ-10) ──────────
    describe('formFieldNames', () => {
        const form = parseFormYaml(`form: Information
entity: contact
type: Main
headerControls:
- id: header_ownerid
  field: ownerid
  control: Lookup
tabs:
- columns:
  - width: 100%
    sections:
    - label: General
      controls:
      - id: fullname
        field: fullname
        control: SingleLineText
      - id: emailaddress1
        field: emailaddress1
        control: SingleLineText
      - id: contacts
        control: Subgrid
        parameters:
          TargetEntityType: contact
      - id: email_again
        field: emailaddress1
        control: SingleLineText
      - id: tn_virtual
        field: tn_virtual
        control: SingleLineText
footerControls:
- id: footer_statecode
  field: statecode
  control: OptionSet
`).model!;

        it('REQ-7: lists each bound field once (body, header and footer), skipping controls with no field such as subgrids', () => {
            assert.deepStrictEqual(formFieldNames(form).sort(), ['emailaddress1', 'fullname', 'ownerid', 'statecode', 'tn_virtual'],
                'Expected every bound attribute exactly once and no subgrid');
        });

        it('REQ-7: when the table is known, leaves out attributes it does not define (they would fail the query)', () => {
            const table = parseTableYaml('entity: contact\nattributes:\n- name: fullname\n  type: String\n- name: emailaddress1\n  type: String\n- name: ownerid\n  type: Owner\n- name: statecode\n  type: State\n').model!;
            assert.deepStrictEqual(formFieldNames(form, table).sort(), ['emailaddress1', 'fullname', 'ownerid', 'statecode'],
                'Expected tn_virtual (not on the table) to be dropped');
        });
    });

    describe('buildRecordFetch', () => {
        it('REQ-7: reads one record by its primary id, selecting the attributes plus the id', () => {
            const xml = buildRecordFetch('contact', ['fullname', 'emailaddress1', 'fullname'], 'contactid', `{${GUID}}`);
            assert.strictEqual(fetchRoot(xml).attrs.top, '1', 'Expected top="1"');
            assert.deepStrictEqual(rootAttributes(xml).sort(), ['contactid', 'emailaddress1', 'fullname'], 'Expected each attribute once, plus the primary id');
            const eq = conditions(xml).filter(c => c.attrs.attribute === 'contactid' && c.attrs.operator === 'eq');
            assert.deepStrictEqual(eq.map(c => c.attrs.value), [GUID_LOWER], 'Expected a contactid eq <lower-case guid> condition');
        });

        it('REQ-7: refuses a non-GUID record id instead of putting it in the query', () => {
            for (const id of ['', 'abc', '"/><condition attribute="x"', "1' OR '1'='1"]) {
                assert.throws(() => buildRecordFetch('contact', ['fullname'], 'contactid', id), GUID_ERROR, `Expected ${JSON.stringify(id)} to throw`);
            }
        });

        it('REQ-7: keeps the query well-formed when an attribute name is hostile', () => {
            const xml = buildRecordFetch('contact', ['fullname', '"/><attribute name="x'], 'contactid', GUID);
            assert.doesNotThrow(() => readFetch(xml), 'Expected well-formed FetchXML');
            assert.ok(!rootAttributes(xml).includes('x'), 'Expected no injected attribute');
        });
    });

    // ── REQ-10: quick view forms ────────────────────────────────────────────
    describe('quickViewRecordRef', () => {
        // Real shape from d365-architect/qad/tn_inspection/information-his.form.yml (control: QuickViewForm on lookup tn_serviceid).
        const QV_ACCOUNT = '840efd51-085b-ef11-bfe2-002248422de6';
        const controlFrom = (parameters: string): FormControl => {
            const model = parseFormYaml(`form: Main
entity: tn_inspection
type: Main
tabs:
- columns:
  - width: 100%
    sections:
    - controls:
      - id: QuickviewControl1
        field: tn_serviceid
        label: Service
        control: QuickViewForm
${parameters}
`).model!;
            return model.tabs[0].columns[0].sections[0].controls[0];
        };
        const single = controlFrom(`        parameters:
          QuickForms:
            xml:
              QuickFormIds:
                QuickFormId:
                  attributes:
                    entityname: account
                  value: ${QV_ACCOUNT}`);
        const polymorphic = controlFrom(`        parameters:
          QuickForms:
            xml:
              QuickFormIds:
                QuickFormId:
                - attributes:
                    entityname: account
                  value: ${QV_ACCOUNT}
                - attributes:
                    entityname: contact
                  value: ${OTHER_GUID}`);

        it('REQ-10: finds the related record id from the lookup the quick view sits on, and its entity from the QuickForms entityname', () => {
            const rec = { _tn_serviceid_value: GUID_LOWER };
            assert.deepStrictEqual(quickViewRecordRef(single, rec), { entity: 'account', id: GUID_LOWER, formId: QV_ACCOUNT },
                'Expected account / the _tn_serviceid_value id / the quick view form id');
        });

        it('REQ-10: normalises the related record id (no braces, lower-case)', () => {
            assert.strictEqual(quickViewRecordRef(single, { _tn_serviceid_value: `{${GUID}}` })?.id, GUID_LOWER, 'Expected a normalised id');
        });

        it('REQ-10: shows nothing when the lookup is empty', () => {
            assert.strictEqual(quickViewRecordRef(single, { _tn_serviceid_value: null }), undefined, 'Expected no related record for a null lookup');
            assert.strictEqual(quickViewRecordRef(single, {}), undefined, 'Expected no related record when the lookup is not on the record');
        });

        it('REQ-10: shows nothing for a control that is not bound to a field', () => {
            const unbound = { ...single, field: undefined } as FormControl;
            assert.strictEqual(quickViewRecordRef(unbound, { _tn_serviceid_value: GUID_LOWER }), undefined, 'Expected no related record without a bound lookup');
        });

        it('REQ-10: shows nothing when the control names no quick view form', () => {
            const bare = controlFrom('        parameters:\n          AutoResolve: true');
            assert.strictEqual(quickViewRecordRef(bare, { _tn_serviceid_value: GUID_LOWER }), undefined, 'Expected no related record without QuickForms');
        });

        it('REQ-10: for a lookup that can point at several tables, picks the quick view form for the table the value is actually in', () => {
            const rec = { _tn_serviceid_value: GUID_LOWER, [`_tn_serviceid_value${LOGICAL_NAME}`]: 'contact' };
            assert.deepStrictEqual(quickViewRecordRef(polymorphic, rec), { entity: 'contact', id: GUID_LOWER, formId: OTHER_GUID },
                'Expected the contact quick view form for a contact value');
        });

        it('REQ-10: shows nothing when the lookup value is in a table the quick view form does not cover', () => {
            const rec = { _tn_serviceid_value: GUID_LOWER, [`_tn_serviceid_value${LOGICAL_NAME}`]: 'contact' };
            assert.strictEqual(quickViewRecordRef(single, rec), undefined, 'Expected no related record: the account quick view cannot show a contact');
        });
    });
});

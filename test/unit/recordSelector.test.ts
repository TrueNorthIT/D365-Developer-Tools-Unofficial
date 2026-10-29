import * as assert from 'assert';
import { FormModel, parseFormYaml, parseTableYaml, parseViewYaml, ViewModel } from '../../src/form/formModel';
import { QuickViewContent, RecordView, RelatedRows, renderFormHtml, SubgridSource } from '../../src/form/formRenderer';
import { parseWebviewMessage, renderLookupResults, renderRecordBar, SIGNED_OUT_TEXT } from '../../src/form/recordBar';
import { clearRecentRecords, FormRecordSource, RecordLocal, RecordRemote } from '../../src/formRecordSource';

/**
 * The live record selector around the pure recordPreview logic: rendering a picked record into the form, the lookup bar,
 * webview message validation and the background loading in FormRecordSource (with a fake Dataverse).
 */

const FORMATTED = '@OData.Community.Display.V1.FormattedValue';
const GUID = '801a405f-eb04-ec11-b6e6-000d3a86bc77';
const OTHER = '0d1e47ff-12b2-4f53-9090-bee951b98cb4';
const QV_FORM = '840efd51-085b-ef11-bfe2-002248422de6';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

const FORM = parseFormYaml(`form: Information
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
      - id: telephone1
        field: telephone1
        control: SingleLineText
      - id: parentcustomerid
        field: parentcustomerid
        control: Lookup
      - id: contacts
        label: Contacts
        control: Subgrid
        parameters:
          TargetEntityType: contact
          ViewId: '{${GUID}}'
          RelationshipName: contact_master_contact
      - id: unrelated
        label: Unrelated
        control: Subgrid
        parameters:
          TargetEntityType: contact
          ViewId: '{${GUID}}'
      - id: qv
        field: parentcustomerid
        label: Organisation
        control: QuickViewForm
        parameters:
          QuickForms:
            xml:
              QuickFormIds:
                QuickFormId:
                  attributes:
                    entityname: account
                  value: ${QV_FORM}
`).model!;

const TABLE = parseTableYaml(`entity: contact
displayName: Contact
attributes:
- name: fullname
  type: String
  displayName: Full Name
- name: telephone1
  type: String
  displayName: Business Phone
- name: parentcustomerid
  type: Customer
  displayName: Company Name
- name: ownerid
  type: Owner
  displayName: Owner
`).model!;

const VIEW = parseViewYaml(`view: Related Contacts
entity: contact
fetchXml: |-
  <fetch version="1.0"><entity name="contact" savedqueryid="${GUID}"><attribute name="fullname"/><attribute name="emailaddress1"/></entity></fetch>
layoutXml: |-
  <grid name="resultset"><row name="result" id="contactid"><cell name="fullname" width="200"/><cell name="emailaddress1" width="200"/></row></grid>
`).model!;

const QV_MODEL = parseFormYaml(`form: Organisation quick view form
entity: account
formId: ${QV_FORM}
type: Quick View Form
tabs:
- columns:
  - width: 100%
    sections:
    - controls:
      - id: telephone1
        field: telephone1
        label: Main Phone
        control: SingleLineText
`).model!;

const subgridSource: SubgridSource = {
    resolveView: () => ({ view: VIEW, origin: 'export' }),
    loadTable: () => undefined,
};

const JANE: Record<string, unknown> = {
    contactid: GUID,
    fullname: 'Jane <Smith>',
    telephone1: null,
    _parentcustomerid_value: OTHER,
    [`_parentcustomerid_value${FORMATTED}`]: 'Contoso Ltd',
    _ownerid_value: OTHER,
    [`_ownerid_value${FORMATTED}`]: 'Joshua Cottrell',
};

const recordView = (o: Partial<RecordView> = {}): RecordView => ({
    record: JANE,
    title: 'Jane <Smith>',
    status: 'Active - Saved',
    subgridRows: () => ({ kind: 'rows', records: [{ fullname: 'John Smith', emailaddress1: 'john@contoso.com' }] }),
    quickView: () => ({ form: { model: QV_MODEL }, record: { telephone1: '01234 567890' } }),
    ...o,
});

describe('live record selector', () => {
    describe('renderFormHtml with a record', () => {
        const html = renderFormHtml(FORM, TABLE, [], subgridSource, recordView());

        it('REQ-7: fills a field with the record\'s value, escaped', () => {
            assert.ok(html.includes('<span class="val">Jane &lt;Smith&gt;</span>'), 'Expected the full name in the field');
            assert.ok(!html.includes('<Smith>'), 'Expected the value to be escaped');
        });

        it('REQ-7: shows "---" for an empty value and a lookup as a link', () => {
            assert.ok(/data-field="telephone1"[^]*?<span class="val empty">---<\/span>/.test(html), 'Expected "---" for the empty phone');
            assert.ok(html.includes('<span class="val link">Contoso Ltd</span>'), 'Expected the lookup name as a link');
        });

        it('REQ-7: fills header fields too', () => {
            assert.ok(html.includes('<div class="hf-val link">Joshua Cottrell</div>'), 'Expected the owner in the header');
        });

        it('REQ-8: titles the form with the record name and its status', () => {
            assert.ok(html.includes('<h1 class="rec">Jane &lt;Smith&gt;</h1>'), 'Expected the record name as the title');
            assert.ok(html.includes('· Active - Saved'), 'Expected the status next to the title');
            assert.ok(!html.includes('(record name)'), 'Expected no placeholder title');
        });

        it('REQ-9: shows the related rows in a subgrid with a relationship', () => {
            assert.ok(html.includes('data-rows="rows"'));
            assert.ok(html.includes('>John Smith<') && html.includes('>john@contoso.com<'), 'Expected the related row\'s cells');
        });

        it('REQ-9: leaves a subgrid without a relationship blank, with a note', () => {
            const unrelated = html.split('class="sg ph-subgrid').find(s => s.includes('>Unrelated<'))!;
            assert.ok(unrelated.includes('data-rows="none"'), 'Expected the unrelated subgrid to have no rows');
            assert.ok(!unrelated.includes('John Smith'), 'Expected no (unfiltered) rows');
            assert.ok(unrelated.includes('This subgrid has no relationship'), 'Expected a note saying why');
        });

        it('REQ-15: shows a failed subgrid\'s error in that subgrid only', () => {
            const failed = renderFormHtml(FORM, TABLE, [], subgridSource, recordView({
                subgridRows: (): RelatedRows => ({ kind: 'error', message: 'Principal user is missing <prvReadContact>' }),
            }));
            assert.ok(failed.includes('sg-note sg-error">Principal user is missing &lt;prvReadContact&gt;</div>'));
            assert.ok(failed.includes('<span class="val link">Contoso Ltd</span>'), 'Expected the rest of the form to render');
        });

        it('REQ-10: renders a quick view from its own layout with the related record\'s values', () => {
            assert.ok(html.includes(`data-quick-view="${QV_FORM}"`), 'Expected the quick view block');
            assert.ok(html.includes('Main Phone') && html.includes('01234 567890'), 'Expected the related record\'s phone');
        });

        it('REQ-10: keeps the placeholder, with a note, when the quick view form is not in the export', () => {
            const missing = renderFormHtml(FORM, TABLE, [], subgridSource, recordView({
                quickView: (): QuickViewContent => ({ note: 'Quick view form x isn\'t in the export' }),
            }));
            assert.ok(missing.includes('ph ph-quickview'));
            assert.ok(missing.includes('isn&#39;t in the export'));
        });

        it('keeps the empty preview when no record is given', () => {
            const empty = renderFormHtml(FORM, TABLE, [], subgridSource);
            assert.ok(empty.includes('(record name)'));
            assert.ok(!empty.includes('data-rows='));
        });
    });

    describe('record bar', () => {
        it('REQ-14: is disabled and asks to sign in when not connected', () => {
            const html = renderRecordBar({ connected: false, entityName: 'Contact' });
            assert.ok(/<input[^>]*disabled/.test(html), 'Expected a disabled input');
            assert.ok(html.includes(SIGNED_OUT_TEXT));
        });

        it('REQ-6 / REQ-16: shows the picked record as a chip with a clear button, and the environment', () => {
            const html = renderRecordBar({ connected: true, entityName: 'Contact', environment: 'https://org.crm11.dynamics.com', selected: { id: GUID, name: 'Jane <S>' } });
            assert.ok(html.includes('rec-chip-name') && html.includes('Jane &lt;S&gt;'));
            assert.ok(html.includes('data-action="clear"'));
            assert.ok(html.includes('Record from https://org.crm11.dynamics.com'));
            assert.ok(!html.includes('<input'), 'Expected no search box while a record is picked');
        });

        it('REQ-4: lists results with the name first and the other columns underneath', () => {
            const html = renderLookupResults({ kind: 'results', items: [{ id: GUID, primary: '', secondary: ['jane@contoso.com'] }] });
            assert.ok(html.includes(`data-id="${GUID}"`));
            assert.ok(html.includes('<div class="rec-primary">(No name)</div><div class="rec-secondary">jane@contoso.com</div>'));
        });
    });

    describe('parseWebviewMessage (REQ-5)', () => {
        it('accepts only the agreed shapes, keeping only the fields the extension uses', () => {
            assert.deepStrictEqual(parseWebviewMessage({ type: 'search', text: 'smith', fetchXml: '<fetch/>' }), { type: 'search', text: 'smith' });
            assert.deepStrictEqual(parseWebviewMessage({ type: 'select', id: `{${GUID.toUpperCase()}}` }), { type: 'select', id: GUID });
            assert.deepStrictEqual(parseWebviewMessage({ type: 'search', text: '', submit: true }), { type: 'search', text: '', submit: true });
            assert.deepStrictEqual(parseWebviewMessage({ type: 'search', text: 'smith', submit: 'yes' }), { type: 'search', text: 'smith' });
            assert.deepStrictEqual(parseWebviewMessage({ type: 'clear' }), { type: 'clear' });
            assert.deepStrictEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
        });

        it('rejects FetchXML, non-GUID ids, non-string or over-long text, and junk', () => {
            for (const bad of [
                { type: 'fetch', fetchXml: '<fetch/>' }, { type: 'select', id: '1 or 1=1' }, { type: 'select' },
                { type: 'search', text: 42 }, { type: 'search', text: 'x'.repeat(201) }, null, 'search', [], {},
            ]) {
                assert.strictEqual(parseWebviewMessage(bad), undefined, `Expected ${JSON.stringify(bad)} to be rejected`);
            }
        });
    });

    describe('FormRecordSource', () => {
        const ENV = 'https://org.crm11.dynamics.com';
        const local: RecordLocal = {
            loadViews: () => [] as ViewModel[],
            loadForms: e => (e === 'account' ? [QV_MODEL] : []) as FormModel[],
            loadTable: () => undefined,
        };

        const fake = (o: Partial<RecordRemote> = {}) => {
            const queries: Array<{ entity: string; fetchXml: string }> = [];
            let env: string | undefined = ENV;
            const remote: RecordRemote = {
                environment: () => env,
                getPrimaryAttributes: async e => (e === 'account' ? { id: 'accountid', name: 'name' } : { id: 'contactid', name: 'fullname' }),
                getAttributes: async e => (e === 'account'
                    ? [{ logicalName: 'telephone1', attributeType: 'String' }]
                    : [...TABLE.attributes.values()].map(a => ({ logicalName: a.name, attributeType: a.type! }))),
                getRelationship: async () => ({ kind: 'OneToMany', schemaName: 'contact_master_contact', referencedEntity: 'contact', referencingEntity: 'contact', referencingAttribute: 'masterid' }),
                getViewByQueryType: async () => undefined,
                executeFetchXml: async (entity, fetchXml) => {
                    queries.push({ entity, fetchXml });
                    if (fetchXml.includes('masterid')) { return [{ fullname: 'John Smith' }]; }
                    if (entity === 'account') { return [{ accountid: OTHER, telephone1: '01234 567890' }]; }
                    return [JANE];
                },
                ...o,
            };
            return { remote, queries, signOut: () => { env = undefined; } };
        };

        /** Renders until nothing more is loading (each background load re-renders, as the panel does). */
        const settle = async (src: FormRecordSource) => {
            for (let i = 0; i < 10; i++) { src.view(FORM, TABLE); await tick(); }
            return src.view(FORM, TABLE);
        };

        beforeEach(() => clearRecentRecords());

        it('REQ-7: reads the record once, selecting every field on the form, and fills the view', async () => {
            const { remote, queries } = fake();
            const src = new FormRecordSource(local, remote, () => undefined);
            src.select('contact', { id: GUID, primary: 'Jane Smith', secondary: [] });
            const result = await settle(src);
            assert.strictEqual(result.record?.title, 'Jane <Smith>');
            const recordQueries = queries.filter(q => q.entity === 'contact' && q.fetchXml.includes('top="1"'));
            assert.strictEqual(recordQueries.length, 1, 'Expected one record query');
            for (const field of ['fullname', 'telephone1', 'parentcustomerid', 'ownerid', 'contactid']) {
                assert.ok(recordQueries[0].fetchXml.includes(`<attribute name="${field}" />`), `Expected ${field} to be read`);
            }
        });

        it('REQ-9 / REQ-10: loads related subgrid rows and the quick view record', async () => {
            const { remote, queries } = fake();
            const src = new FormRecordSource(local, remote, () => undefined);
            src.select('contact', { id: GUID, primary: 'Jane Smith', secondary: [] });
            let result = await settle(src);
            result.record!.subgridRows!(FORM.tabs[0].columns[0].sections[0].controls[3], VIEW);
            result.record!.quickView!(FORM.tabs[0].columns[0].sections[0].controls[5]);
            result = await settle(src);
            const rows = result.record!.subgridRows!(FORM.tabs[0].columns[0].sections[0].controls[3], VIEW);
            assert.deepStrictEqual(rows, { kind: 'rows', records: [{ fullname: 'John Smith' }] });
            const related = queries.find(q => q.fetchXml.includes('masterid'))!;
            assert.ok(related.fetchXml.includes(`value="${GUID}"`), 'Expected the subgrid filtered to this record');
            const qv = result.record!.quickView!(FORM.tabs[0].columns[0].sections[0].controls[5]);
            assert.deepStrictEqual(qv.record, { accountid: OTHER, telephone1: '01234 567890' });
            assert.strictEqual(qv.form?.model.formId, QV_FORM);
        });

        it('REQ-15: shows Dynamics\' error as a notice when the record cannot be read', async () => {
            const { remote } = fake({ executeFetchXml: async () => { throw new Error('Dataverse API error 403: {"error":{"message":"No read access"}}'); } });
            const src = new FormRecordSource(local, remote, () => undefined);
            src.select('contact', { id: GUID, primary: 'Jane Smith', secondary: [] });
            const result = await settle(src);
            assert.strictEqual(result.record, undefined);
            assert.deepStrictEqual(result.notices, ['No read access']);
        });

        it('REQ-3: retries a rejected Quick Find search on the primary name only', async () => {
            const QF = '<fetch><entity name="contact"><filter type="or" isquickfindfields="1"><condition attribute="parentcustomerid" operator="like" value="{0}"/></filter></entity></fetch>';
            const searches: string[] = [];
            const { remote } = fake({
                getViewByQueryType: async (_e, qt) => (qt === 4 ? { name: 'Quick Find', fetchXml: QF } : undefined),
                executeFetchXml: async (_e, fetchXml) => {
                    searches.push(fetchXml);
                    if (fetchXml.includes('parentcustomerid')) { throw new Error('Dataverse API error 400: like on a lookup'); }
                    return [{ contactid: GUID, fullname: 'Jane Smith' }];
                },
            });
            const src = new FormRecordSource(local, remote, () => undefined);
            const results = await src.search('contact', 'jane');
            assert.deepStrictEqual(results, [{ id: GUID, primary: 'Jane Smith', secondary: [] }]);
            assert.strictEqual(searches.length, 2);
            assert.ok(searches[1].includes('attribute="fullname" operator="like" value="%jane%"'));
            await src.search('contact', 'jane');
            assert.strictEqual(searches.length, 3, 'Expected later searches to skip the rejected Quick Find query');
        });

        it('REQ-2 / REQ-13: remembers picked records as recent, and forgets the selection on reset', async () => {
            const { remote } = fake();
            const src = new FormRecordSource(local, remote, () => undefined);
            src.select('contact', { id: GUID, primary: 'Jane Smith', secondary: [] });
            src.select('contact', { id: OTHER, primary: 'John Smith', secondary: [] });
            assert.deepStrictEqual(src.recents('contact').map(r => r.primary), ['John Smith', 'Jane Smith']);
            assert.deepStrictEqual(new FormRecordSource(local, remote, () => undefined).recents('contact').length, 2, 'Expected recents shared across panels');
            src.reset();
            assert.strictEqual(src.selected, undefined);
            assert.deepStrictEqual(src.view(FORM, TABLE), { notices: [] });
        });

        it('REQ-12: re-fetches the record once when the form gains a field it lacks', async () => {
            const { remote, queries } = fake();
            const src = new FormRecordSource(local, remote, () => undefined, 0);
            src.select('contact', { id: GUID, primary: 'Jane Smith', secondary: [] });
            const small = parseFormYaml('entity: contact\ntabs:\n- columns:\n  - sections:\n    - controls:\n      - field: fullname\n').model!;
            const bigger = parseFormYaml('entity: contact\ntabs:\n- columns:\n  - sections:\n    - controls:\n      - field: fullname\n      - field: telephone1\n').model!;
            for (let i = 0; i < 5; i++) { src.view(small, TABLE); await tick(); }
            for (let i = 0; i < 5; i++) { src.view(bigger, TABLE); await new Promise(r => setTimeout(r, 1)); }
            const recordQueries = queries.filter(q => q.fetchXml.includes('top="1"'));
            assert.strictEqual(recordQueries.length, 2, 'Expected one re-fetch for the added field');
            assert.ok(recordQueries[1].fetchXml.includes('telephone1'));
        });
    });
});

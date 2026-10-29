import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findViewById, parseFormYaml, parseTableYaml, parseViewYaml, TableModel, ViewModel } from '../../src/form/formModel';
import { renderFormHtml, SubgridSource } from '../../src/form/formRenderer';
import { SiblingTableLoader } from '../../src/form/viewLoader';
import { FormSubgridSource, LocalExport, RemoteMetadata } from '../../src/formSubgridSource';

const GUID = '801A405F-EB04-EC11-B6E6-000D3A86BC77';

const FETCH = (savedQueryId = '') => `<fetch version="1.0"><entity name="contact" ${savedQueryId ? `savedqueryid="${savedQueryId}"` : ''}><attribute name="fullname"/><attribute name="contactid"/><link-entity alias="a_1" name="account" to="parentcustomerid" from="accountid" link-type="outer"><attribute name="name"/></link-entity></entity></fetch>`;
const LAYOUT = '<grid name="resultset"><row name="result" id="contactid"><cell name="fullname" width="200"/><cell name="a_1.name" width="100"/><cell name="telephone1"/></row></grid>';

const viewYaml = (name: string, extra = '', savedQueryId = '') => `view: ${name}
entity: contact
${extra}fetchXml: |-
  ${FETCH(savedQueryId)}
layoutXml: |-
  ${LAYOUT}
`;

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('subgrid views', () => {
    describe('parseViewYaml', () => {
        it('reads columns, widths, link entities and the embedded savedqueryid', () => {
            const v = parseViewYaml(viewYaml('Contacts', 'isDefault: true\n', GUID)).model!;
            assert.deepStrictEqual(v.columns, [
                { name: 'fullname', width: 200 },
                { name: 'a_1.name', width: 100 },
                { name: 'telephone1', width: undefined },
            ]);
            assert.strictEqual(v.linkEntities.get('a_1'), 'account');
            assert.strictEqual(v.savedQueryId, GUID.toLowerCase());
            assert.strictEqual(v.isDefault, true);
        });

        it('falls back to FetchXML attributes (minus the primary id) when there is no layoutXml', () => {
            const text = 'view: Lookup\nentity: contact\nqueryType: LookupView\nfetchXml: |-\n  <fetch><entity name="contact"><attribute name="fullname"/><attribute name="contactid"/></entity></fetch>\n';
            assert.deepStrictEqual(parseViewYaml(text).model!.columns, [{ name: 'fullname' }]);
        });

        it('rejects a document without fetchXml', () => {
            assert.ok(parseViewYaml('view: x').errors.length > 0);
        });
    });

    describe('findViewById', () => {
        const mk = (name: string, o: Partial<ViewModel> = {}): ViewModel => ({
            name, entity: 'contact', isDefault: false, columns: [{ name: 'a' }], linkEntities: new Map(), ...o,
        });

        it('matches exactly on the savedqueryid, ignoring braces and case', () => {
            const views = [mk('A'), mk('B', { savedQueryId: GUID.toLowerCase() })];
            assert.strictEqual(findViewById(views, `{${GUID}}`)?.name, 'B');
        });

        it('never substitutes a different view: a miss is a miss, even if a SubGrid or default view exists', () => {
            const views = [mk('Default', { isDefault: true }), mk('Sub', { queryType: 'SubGrid' })];
            assert.strictEqual(findViewById(views, GUID), undefined);
            assert.strictEqual(findViewById(views, undefined), undefined);
        });
    });

    describe('FormSubgridSource', () => {
        const exported = parseViewYaml(viewYaml('Exported Contacts', '', GUID)).model!;
        const exportedTable = parseTableYaml('entity: contact\nattributes:\n- name: fullname\n  displayName: Full Name\n').model!;

        const localWith = (views: ViewModel[], tables: Record<string, TableModel> = {}): LocalExport => ({
            loadViews: () => views,
            loadTable: e => tables[e],
        });

        const remoteFake = (o: Partial<RemoteMetadata> & { connected?: boolean } = {}) => {
            const calls = { savedQuery: 0, attributes: 0 };
            const remote: RemoteMetadata = {
                isConnected: () => o.connected ?? true,
                getSavedQuery: o.getSavedQuery ?? (async () => {
                    calls.savedQuery++;
                    return { name: 'Dynamics Contacts', entity: 'contact', queryType: 2, isDefault: false, fetchXml: FETCH(), layoutXml: LAYOUT };
                }),
                getAttributes: o.getAttributes ?? (async () => {
                    calls.attributes++;
                    return [{ logicalName: 'telephone1', displayName: 'Business Phone', attributeType: 'String' }];
                }),
                getEntityDisplayName: o.getEntityDisplayName ?? (async () => 'Contact'),
            };
            return { remote, calls };
        };

        it('prefers the export and never touches Dynamics when the view is on disk', async () => {
            const { remote, calls } = remoteFake();
            const src = new FormSubgridSource(localWith([exported]), remote, () => assert.fail('no refresh expected'));
            const r = src.resolveView('contact', `{${GUID}}`);
            await tick();
            assert.strictEqual(r.origin, 'export');
            assert.strictEqual(r.view?.name, 'Exported Contacts');
            assert.strictEqual(calls.savedQuery, 0);
        });

        it('falls back to Dynamics: first call is blank + starts a fetch, then the view arrives and onChange fires', async () => {
            const { remote, calls } = remoteFake();
            let changes = 0;
            const src = new FormSubgridSource(localWith([]), remote, () => { changes++; });

            assert.deepStrictEqual(src.resolveView('contact', GUID), {});
            await tick();
            assert.strictEqual(changes, 1);

            const r = src.resolveView('contact', GUID);
            assert.strictEqual(r.origin, 'dynamics');
            assert.strictEqual(r.view?.name, 'Dynamics Contacts');
            assert.strictEqual(r.view?.queryType, 'SubGrid');
            assert.strictEqual(r.view?.savedQueryId, GUID.toLowerCase());
            assert.deepStrictEqual(r.view?.columns.map(c => c.name), ['fullname', 'a_1.name', 'telephone1']);
            assert.strictEqual(calls.savedQuery, 1, 'cached after the first fetch');
        });

        it('does not start duplicate fetches while one is in flight', async () => {
            let release!: () => void;
            let started = 0;
            const { remote } = remoteFake({
                getSavedQuery: () => { started++; return new Promise(res => { release = () => res(undefined); }); },
            });
            const src = new FormSubgridSource(localWith([]), remote, () => undefined);
            src.resolveView('contact', GUID);
            src.resolveView('contact', GUID);
            src.resolveView('contact', GUID);
            assert.strictEqual(started, 1);
            release();
            await tick();
        });

        it('stays blank when offline / not signed in, without calling Dynamics', async () => {
            const { remote, calls } = remoteFake({ connected: false });
            const src = new FormSubgridSource(localWith([]), remote, () => assert.fail('no refresh expected'));
            assert.deepStrictEqual(src.resolveView('contact', GUID), {});
            await tick();
            assert.strictEqual(calls.savedQuery, 0);
        });

        it('stays blank with no remote at all', () => {
            const src = new FormSubgridSource(localWith([]), undefined, () => assert.fail('no refresh expected'));
            assert.deepStrictEqual(src.resolveView('contact', GUID), {});
            assert.strictEqual(src.loadTable('contact'), undefined);
        });

        it('remembers a failed fetch (no retry storm) until reset(), then retries', async () => {
            let attempts = 0;
            const { remote } = remoteFake({ getSavedQuery: async () => { attempts++; throw new Error('network down'); } });
            const src = new FormSubgridSource(localWith([]), remote, () => assert.fail('no refresh on failure'));

            src.resolveView('contact', GUID);
            await tick();
            src.resolveView('contact', GUID);
            await tick();
            assert.strictEqual(attempts, 1);

            src.reset();
            src.resolveView('contact', GUID);
            await tick();
            assert.strictEqual(attempts, 2);
        });

        it('treats "view not found" in Dynamics as a miss, not an error', async () => {
            const { remote } = remoteFake({ getSavedQuery: async () => undefined });
            const src = new FormSubgridSource(localWith([]), remote, () => assert.fail('no refresh when nothing found'));
            src.resolveView('contact', GUID);
            await tick();
            assert.deepStrictEqual(src.resolveView('contact', GUID), {});
        });

        it('loads table labels from the export first, then from Dynamics', async () => {
            const { remote, calls } = remoteFake();
            let changes = 0;
            const src = new FormSubgridSource(localWith([], { contact: exportedTable }), remote, () => { changes++; });
            assert.strictEqual(src.loadTable('contact')?.attributes.get('fullname')?.displayName, 'Full Name');
            assert.strictEqual(calls.attributes, 0);

            assert.strictEqual(src.loadTable('account'), undefined);
            await tick();
            assert.strictEqual(changes, 1);
            const t = src.loadTable('account');
            assert.strictEqual(t?.displayName, 'Contact');
            assert.strictEqual(t?.attributes.get('telephone1')?.displayName, 'Business Phone');
        });

        it('ignores results that arrive after dispose()', async () => {
            const { remote } = remoteFake();
            const src = new FormSubgridSource(localWith([]), remote, () => assert.fail('disposed'));
            src.resolveView('contact', GUID);
            src.dispose();
            await tick();
        });
    });

    describe('rendering a subgrid', () => {
        const form = parseFormYaml(`entity: account
tabs:
- columns:
  - sections:
    - controls:
      - id: sg
        label: Contacts
        control: Subgrid
        showLabel: false
        parameters:
          TargetEntityType: contact
          ViewId: '{${GUID}}'
          ViewIds: '{${GUID}},{00000000-0000-0000-00AA-000010001004}'
`).model!;

        const view = parseViewYaml(viewYaml('Active Contacts', '', GUID)).model!;
        const contactTable = parseTableYaml('entity: contact\ndisplayName: Contact\nattributes:\n- name: fullname\n  displayName: Full Name\n- name: telephone1\n  displayName: Business Phone\n').model!;
        const accountTable = parseTableYaml('entity: account\nattributes:\n- name: name\n  displayName: Account Name\n').model!;
        const source = (origin: 'export' | 'dynamics' | undefined, v: ViewModel | undefined = view): SubgridSource => ({
            resolveView: () => (origin ? { view: v, origin } : {}),
            loadTable: e => (e === 'contact' ? contactTable : e === 'account' ? accountTable : undefined),
        });

        it('renders the view name, column headers from the target table and linked-entity columns', () => {
            const html = renderFormHtml(form, undefined, [], source('export'));
            assert.ok(html.includes('Active Contacts'));
            assert.ok(html.includes('>Full Name<'));
            assert.ok(html.includes('>Account Name<'), 'linked column labelled from the linked table');
            assert.ok(html.includes('>Business Phone<'));
            assert.ok(html.includes('data-view-origin="export"'));
            assert.ok(html.includes('from export'));
            assert.ok(html.includes('Active Contacts ▾'), 'multiple ViewIds show a view picker caret');
        });

        it('says when the view came from Dynamics', () => {
            const html = renderFormHtml(form, undefined, [], source('dynamics'));
            assert.ok(html.includes('data-view-origin="dynamics"'));
            assert.ok(html.includes('from Dynamics'));
        });

        it('renders the real subgrid toolbar: New <entity>, Refresh, Flow, Run Report and the keyword filter', () => {
            const html = renderFormHtml(form, undefined, [], source('export'));
            assert.ok(html.includes('+ New Contact'));
            for (const label of ['Refresh', 'Flow', 'Run Report', 'Filter by keyword']) {
                assert.ok(html.includes(label), label);
            }
        });

        it('leaves the grid blank (toolbar kept, no columns) when no view is available', () => {
            const html = renderFormHtml(form, undefined, [], source(undefined));
            assert.ok(html.includes('sg-blank'));
            assert.ok(html.includes('data-view-origin="none"'));
            assert.ok(html.includes('sg-cmd'), 'toolbar still shown');
            assert.ok(!html.includes('<table'), 'no guessed columns');
            assert.ok(!html.includes('Active Contacts'));
            assert.ok(html.includes("isn't in the export and couldn't be fetched from Dynamics"));
        });

        it('keeps the generic placeholder when no subgrid source is supplied at all', () => {
            const html = renderFormHtml(form);
            assert.ok(html.includes('ph ph-subgrid'));
            assert.ok(!html.includes('data-view-origin'));
        });
    });

    describe('SiblingTableLoader', () => {
        let root: string;
        beforeEach(() => {
            root = fs.mkdtempSync(path.join(os.tmpdir(), 'd365-views-'));
            fs.mkdirSync(path.join(root, 'contact'));
            fs.writeFileSync(path.join(root, 'contact', 'active.view.yml'), viewYaml('Active', '', GUID));
            fs.writeFileSync(path.join(root, 'contact', 'bad.view.yml'), 'not: a view');
            fs.writeFileSync(path.join(root, 'contact', 'contact.table.yml'), 'entity: contact\nattributes:\n- name: fullname\n  displayName: Full Name\n');
        });
        afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

        it('loads valid views from the sibling entity folder and skips invalid ones', () => {
            const views = new SiblingTableLoader(root).loadViews('contact');
            assert.deepStrictEqual(views.map(v => v.name), ['Active']);
        });

        it('returns empty/undefined for entities that were not exported', () => {
            const loader = new SiblingTableLoader(root);
            assert.deepStrictEqual(loader.loadViews('nope'), []);
            assert.strictEqual(loader.loadTable('nope'), undefined);
        });

        it('loads the sibling table and picks up edits to a view file', () => {
            const loader = new SiblingTableLoader(root);
            assert.strictEqual(loader.loadTable('contact')?.attributes.get('fullname')?.displayName, 'Full Name');
            const file = path.join(root, 'contact', 'active.view.yml');
            fs.writeFileSync(file, viewYaml('Renamed', '', GUID));
            fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
            assert.deepStrictEqual(loader.loadViews('contact').map(v => v.name), ['Renamed']);
        });
    });
});

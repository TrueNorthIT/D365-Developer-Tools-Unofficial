import * as assert from 'assert';
import * as sinon from 'sinon';
import * as zlib from 'zlib';
import { DataverseClient } from '../../src/dataverseClient';
import type { ConnectionManager } from '../../src/connectionManager';
import { buildZip } from '../helpers/zip';

const ENV_URL = 'https://contoso.crm.dynamics.com';
const TOKEN = 'fake-token-123';

function fakeConnectionManager(overrides: Partial<{ environmentUrl: string; token: string }> = {}): ConnectionManager {
    const environmentUrl = overrides.environmentUrl ?? ENV_URL;
    const token = overrides.token ?? TOKEN;
    return {
        connection: { environmentUrl },
        getAccessToken: sinon.stub().resolves(token),
    } as unknown as ConnectionManager;
}

interface FakeResponseInit {
    ok?: boolean;
    status?: number;
    statusText?: string;
    json?: () => Promise<unknown>;
    text?: () => Promise<string>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    headers?: Record<string, string | undefined>;
}

function fakeResponse(init: FakeResponseInit = {}): Response {
    const headersMap = init.headers ?? {};
    return {
        ok: init.ok ?? true,
        status: init.status ?? 200,
        statusText: init.statusText ?? 'OK',
        json: init.json ?? (async () => ({})),
        text: init.text ?? (async () => ''),
        arrayBuffer: init.arrayBuffer ?? (async () => new ArrayBuffer(0)),
        headers: {
            get: (name: string) => headersMap[name] ?? null,
        },
    } as unknown as Response;
}

function label(text: string | undefined, languageCode = 1033): { LocalizedLabels: Array<{ Label: string; LanguageCode: number }>; UserLocalizedLabel?: { Label: string; LanguageCode: number } } {
    if (text === undefined) {
        return { LocalizedLabels: [] };
    }
    return {
        LocalizedLabels: [{ Label: text, LanguageCode: languageCode }],
        UserLocalizedLabel: { Label: text, LanguageCode: languageCode },
    };
}

describe('DataverseClient', () => {
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
        fetchStub = sinon.stub(global, 'fetch');
    });

    afterEach(() => {
        sinon.restore();
    });

    // ── getEntities ──────────────────────────────────────────────────────

    describe('getEntities', () => {
        it('builds the correct URL and query', async () => {
            fetchStub.resolves(fakeResponse({ json: async () => ({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.getEntities();

            assert.strictEqual(fetchStub.callCount, 1);
            const [url] = fetchStub.firstCall.args;
            assert.strictEqual(
                url,
                `${ENV_URL}/api/data/v9.2/EntityDefinitions?$select=MetadataId,LogicalName,SchemaName,DisplayName,IsCustomEntity,IconVectorName,ObjectTypeCode`,
            );
        });

        it('maps response fields and sorts by logicalName', async () => {
            fetchStub.resolves(fakeResponse({
                json: async () => ({
                    value: [
                        {
                            MetadataId: 'meta-2',
                            LogicalName: 'zzz_entity',
                            SchemaName: 'zzz_Entity',
                            DisplayName: label('Zzz Entity'),
                            IsCustomEntity: true,
                        },
                        {
                            MetadataId: 'meta-1',
                            LogicalName: 'aaa_entity',
                            SchemaName: 'aaa_Entity',
                            DisplayName: label(undefined),
                            IsCustomEntity: false,
                        },
                    ],
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getEntities();

            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].logicalName, 'aaa_entity');
            assert.strictEqual(result[0].metadataId, 'meta-1');
            assert.strictEqual(result[0].schemaName, 'aaa_Entity');
            // no labels -> falls back to SchemaName
            assert.strictEqual(result[0].displayName, 'aaa_Entity');
            assert.strictEqual(result[0].isCustom, false);

            assert.strictEqual(result[1].logicalName, 'zzz_entity');
            assert.strictEqual(result[1].displayName, 'Zzz Entity');
            assert.strictEqual(result[1].isCustom, true);
        });

        it('rejects with an error including the status code on a non-ok response', async () => {
            fetchStub.resolves(fakeResponse({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'detail' }));
            const client = new DataverseClient(fakeConnectionManager());

            await assert.rejects(
                () => client.getEntities(),
                (err: Error) => {
                    assert.match(err.message, /404/);
                    assert.match(err.message, /detail/);
                    return true;
                },
            );
        });

        it('sends the Authorization header and OData headers using the token from getAccessToken', async () => {
            fetchStub.resolves(fakeResponse({ json: async () => ({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager({ token: 'my-special-token' }));
            await client.getEntities();

            const [, requestInit] = fetchStub.firstCall.args;
            assert.deepStrictEqual(requestInit.headers, {
                Authorization: 'Bearer my-special-token',
                'OData-MaxVersion': '4.0',
                'OData-Version': '4.0',
                Accept: 'application/json',
            });
        });

        it('follows @odata.nextLink and concatenates both pages', async () => {
            const nextLink = `${ENV_URL}/api/data/v9.2/EntityDefinitions?$skiptoken=abc`;
            fetchStub.onCall(0).resolves(fakeResponse({
                json: async () => ({
                    value: [{ MetadataId: 'm1', LogicalName: 'entity_one', SchemaName: 'EntityOne', DisplayName: label('One'), IsCustomEntity: false }],
                    '@odata.nextLink': nextLink,
                }),
            }));
            fetchStub.onCall(1).resolves(fakeResponse({
                json: async () => ({
                    value: [{ MetadataId: 'm2', LogicalName: 'entity_two', SchemaName: 'EntityTwo', DisplayName: label('Two'), IsCustomEntity: false }],
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getEntities();

            assert.strictEqual(fetchStub.callCount, 2);
            assert.strictEqual(fetchStub.secondCall.args[0], nextLink);
            assert.strictEqual(result.length, 2);
            assert.deepStrictEqual(result.map(r => r.logicalName).sort(), ['entity_one', 'entity_two']);
        });
    });

    // ── getAttributes ────────────────────────────────────────────────────

    describe('getAttributes', () => {
        it('embeds the entity name in the URL', async () => {
            fetchStub.resolves(fakeResponse({ json: async () => ({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.getAttributes('account');

            const [url] = fetchStub.firstCall.args;
            assert.strictEqual(
                url,
                `${ENV_URL}/api/data/v9.2/EntityDefinitions(LogicalName='account')/Attributes?$select=LogicalName,SchemaName,DisplayName,AttributeType,IsPrimaryId,IsPrimaryName`,
            );
        });

        it('maps response fields, falls back to SchemaName, and sorts by logicalName', async () => {
            fetchStub.resolves(fakeResponse({
                json: async () => ({
                    value: [
                        {
                            LogicalName: 'zfield',
                            SchemaName: 'ZField',
                            DisplayName: label('Z Field'),
                            AttributeType: 'String',
                            IsPrimaryId: false,
                            IsPrimaryName: false,
                        },
                        {
                            LogicalName: 'afield',
                            SchemaName: 'AField',
                            DisplayName: label(undefined),
                            AttributeType: 'Integer',
                            IsPrimaryId: true,
                            IsPrimaryName: false,
                        },
                    ],
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getAttributes('account');

            assert.strictEqual(result.length, 2);
            assert.strictEqual(result[0].logicalName, 'afield');
            assert.strictEqual(result[0].displayName, 'AField');
            assert.strictEqual(result[0].isPrimaryId, true);
            assert.strictEqual(result[1].logicalName, 'zfield');
            assert.strictEqual(result[1].displayName, 'Z Field');
            assert.strictEqual(result[1].attributeType, 'String');
        });

        it('follows pagination across multiple pages', async () => {
            const nextLink = `${ENV_URL}/api/data/v9.2/next-page`;
            fetchStub.onCall(0).resolves(fakeResponse({
                json: async () => ({
                    value: [{ LogicalName: 'f1', SchemaName: 'F1', DisplayName: label('F1'), AttributeType: 'String', IsPrimaryId: false, IsPrimaryName: false }],
                    '@odata.nextLink': nextLink,
                }),
            }));
            fetchStub.onCall(1).resolves(fakeResponse({
                json: async () => ({
                    value: [{ LogicalName: 'f2', SchemaName: 'F2', DisplayName: label('F2'), AttributeType: 'String', IsPrimaryId: false, IsPrimaryName: false }],
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getAttributes('account');

            assert.strictEqual(fetchStub.callCount, 2);
            assert.strictEqual(result.length, 2);
        });
    });

    // ── getEntityRibbonMetadata ──────────────────────────────────────────

    describe('getEntityRibbonMetadata', () => {
        it('requests the expected fields and maps labels/fallbacks', async () => {
            fetchStub.resolves(fakeResponse({
                text: async () => JSON.stringify({
                    MetadataId: 'entity-metadata-id',
                    SchemaName: 'tn_JCTesttable',
                    DisplayName: label('JC Test table'),
                    DisplayCollectionName: label('JC Test tables'),
                    Description: label(''),
                    EntitySetName: 'tn_jctesttables',
                    OwnershipType: 'UserOwned',
                    IntroducedVersion: '1.0',
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getEntityRibbonMetadata('tn_jctesttable');

            const [url] = fetchStub.firstCall.args;
            assert.strictEqual(
                url,
                `${ENV_URL}/api/data/v9.2/EntityDefinitions(LogicalName='tn_jctesttable')?$select=MetadataId,SchemaName,DisplayName,DisplayCollectionName,Description,EntitySetName,OwnershipType,IntroducedVersion`,
            );
            assert.deepStrictEqual(result, {
                metadataId: 'entity-metadata-id',
                schemaName: 'tn_JCTesttable',
                displayName: 'JC Test table',
                displayCollectionName: 'JC Test tables',
                description: '',
                entitySetName: 'tn_jctesttables',
                ownershipType: 'UserOwned',
                introducedVersion: '1.0',
            });
        });

        it('falls back to SchemaName for missing display names, "UserOwned" for missing ownership type, and "1.0" for missing introduced version', async () => {
            fetchStub.resolves(fakeResponse({
                text: async () => JSON.stringify({
                    SchemaName: 'tn_JCTesttable',
                    DisplayName: label(undefined),
                    DisplayCollectionName: label(undefined),
                    Description: label(undefined),
                    EntitySetName: 'tn_jctesttables',
                    OwnershipType: null,
                    IntroducedVersion: null,
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getEntityRibbonMetadata('tn_jctesttable');

            assert.strictEqual(result.displayName, 'tn_JCTesttable');
            assert.strictEqual(result.displayCollectionName, 'tn_JCTesttable');
            assert.strictEqual(result.ownershipType, 'UserOwned');
            assert.strictEqual(result.introducedVersion, '1.0');
        });

        it('throws when no metadata is returned', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '' }));
            const client = new DataverseClient(fakeConnectionManager());
            await assert.rejects(() => client.getEntityRibbonMetadata('tn_jctesttable'), /No metadata returned/);
        });
    });

    // ── getSolutions ─────────────────────────────────────────────────────

    describe('getSolutions', () => {
        it('requests only visible solutions and maps fields', async () => {
            fetchStub.resolves(fakeResponse({
                json: async () => ({
                    value: [
                        { solutionid: 'sol-1', uniquename: 'MySolution', friendlyname: 'My Solution' },
                    ],
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getSolutions();

            const [url] = fetchStub.firstCall.args;
            assert.match(url, /\$filter=isvisible eq true/);
            assert.strictEqual(result.length, 1);
            assert.deepStrictEqual(result[0], {
                solutionId: 'sol-1',
                uniqueName: 'MySolution',
                friendlyName: 'My Solution',
            });
        });
    });

    // ── getAttributeOptions ──────────────────────────────────────────────

    describe('getAttributeOptions', () => {
        for (const [type, cast] of [
            ['Picklist', 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata'],
            ['State', 'Microsoft.Dynamics.CRM.StateAttributeMetadata'],
            ['Status', 'Microsoft.Dynamics.CRM.StatusAttributeMetadata'],
        ]) {
            it(`uses the correct OData cast for attribute type ${type}`, async () => {
                fetchStub.resolves(fakeResponse({ json: async () => ({ OptionSet: { Options: [] } }) }));
                const client = new DataverseClient(fakeConnectionManager());
                await client.getAttributeOptions('account', 'statuscode', type);

                const [url] = fetchStub.firstCall.args;
                assert.strictEqual(
                    url,
                    `${ENV_URL}/api/data/v9.2/EntityDefinitions(LogicalName='account')/Attributes(LogicalName='statuscode')/${cast}?$expand=OptionSet,GlobalOptionSet`,
                );
            });
        }

        it('throws for an unsupported attribute type without calling fetch', async () => {
            const client = new DataverseClient(fakeConnectionManager());
            await assert.rejects(
                () => client.getAttributeOptions('account', 'name', 'String'),
                /is not an option-set attribute type/,
            );
            assert.strictEqual(fetchStub.callCount, 0);
        });

        it('falls back to GlobalOptionSet when OptionSet is absent', async () => {
            fetchStub.resolves(fakeResponse({
                json: async () => ({
                    GlobalOptionSet: { Options: [{ Value: 1, Label: label('Open') }] },
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getAttributeOptions('account', 'statuscode', 'Status');

            assert.deepStrictEqual(result, [{ value: 1, label: 'Open' }]);
        });

        it('falls back to String(value) when no label is present', async () => {
            fetchStub.resolves(fakeResponse({
                json: async () => ({
                    OptionSet: { Options: [{ Value: 42, Label: label(undefined) }] },
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getAttributeOptions('account', 'statuscode', 'Picklist');

            assert.deepStrictEqual(result, [{ value: 42, label: '42' }]);
        });

        it('rejects with an error including the status code on a non-ok response', async () => {
            fetchStub.resolves(fakeResponse({ ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' }));
            const client = new DataverseClient(fakeConnectionManager());

            await assert.rejects(
                () => client.getAttributeOptions('account', 'statuscode', 'Picklist'),
                /500/,
            );
        });
    });

    // ── getSolutionEntityIds ─────────────────────────────────────────────

    describe('getSolutionEntityIds', () => {
        it('returns a Set of objectids and embeds the solutionId/componenttype filter', async () => {
            fetchStub.resolves(fakeResponse({
                json: async () => ({ value: [{ objectid: 'obj-1' }, { objectid: 'obj-2' }] }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getSolutionEntityIds('sol-abc');

            const [url] = fetchStub.firstCall.args;
            assert.match(url, /\$filter=_solutionid_value eq 'sol-abc' and componenttype eq 1/);
            assert.ok(result instanceof Set);
            assert.deepStrictEqual([...result].sort(), ['obj-1', 'obj-2']);
        });
    });

    // ── searchWebResources ───────────────────────────────────────────────

    describe('searchWebResources', () => {
        it('returns the matched web resource names in the order the server returned them', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [{ name: 'new_a.js' }, { name: 'new_b.js' }] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.searchWebResources('new_');
            assert.deepStrictEqual(result, ['new_a.js', 'new_b.js']);
        });

        it('filters by a contains() on name, ordered by name and capped at 25', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.searchWebResources('icon');

            const [url] = fetchStub.firstCall.args;
            assert.match(url, /\$filter=contains\(name,'icon'\)/);
            assert.match(url, /\$orderby=name/);
            assert.match(url, /\$top=25/);
        });

        it('omits the filter entirely for an empty/whitespace-only query, still returning up to 25 results', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.searchWebResources('   ');

            const [url] = fetchStub.firstCall.args;
            assert.doesNotMatch(url, /\$filter=/);
        });

        it('escapes single quotes in the query by doubling them', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.searchWebResources("o'brien");

            const [url] = fetchStub.firstCall.args;
            assert.match(url, /\$filter=contains\(name,'o''brien'\)/);
        });

        it('returns an empty array when the response has no value', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({}) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.searchWebResources('new_');
            assert.deepStrictEqual(result, []);
        });
    });

    // ── getWebResourceIdByName ───────────────────────────────────────────

    describe('getWebResourceIdByName', () => {
        it('returns undefined when no match is found', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getWebResourceIdByName('new_myscript.js');
            assert.strictEqual(result, undefined);
        });

        it('returns the id when a match is found', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [{ webresourceid: 'wr-1' }] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getWebResourceIdByName('new_myscript.js');
            assert.strictEqual(result, 'wr-1');
        });

        it('escapes single quotes in the name by doubling them', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.getWebResourceIdByName("new_o'brien.js");

            const [url] = fetchStub.firstCall.args;
            assert.match(url, /\$filter=name eq 'new_o''brien\.js'/);
        });
    });

    // ── getWebResourceContent ────────────────────────────────────────────

    describe('getWebResourceContent', () => {
        it('returns the content field', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ content: 'YmFzZTY0' }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getWebResourceContent('wr-1');
            assert.strictEqual(result, 'YmFzZTY0');
        });

        it("falls back to '' when the content field is missing", async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({}) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getWebResourceContent('wr-1');
            assert.strictEqual(result, '');
        });
    });

    // ── createWebResource ────────────────────────────────────────────────

    describe('createWebResource', () => {
        const params = { name: 'new_myscript.js', displayName: 'My Script', type: 3, contentBase64: 'YmFzZTY0' };

        it('POSTs with the correct body and parses the created id from the OData-EntityId header', async () => {
            const guid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
            fetchStub.resolves(fakeResponse({
                headers: { 'OData-EntityId': `${ENV_URL}/api/data/v9.2/webresourceset(${guid})` },
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.createWebResource(params);

            assert.strictEqual(result, guid);
            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/webresourceset`);
            assert.strictEqual(requestInit.method, 'POST');
            assert.strictEqual(requestInit.headers['Content-Type'], 'application/json');
            assert.deepStrictEqual(JSON.parse(requestInit.body), {
                name: 'new_myscript.js',
                displayname: 'My Script',
                webresourcetype: 3,
                content: 'YmFzZTY0',
            });
        });

        it('throws when the OData-EntityId header is missing', async () => {
            fetchStub.resolves(fakeResponse({ headers: {} }));
            const client = new DataverseClient(fakeConnectionManager());

            await assert.rejects(
                () => client.createWebResource(params),
                /could not be determined/,
            );
        });

        it("throws when the OData-EntityId header doesn't match the expected GUID pattern", async () => {
            fetchStub.resolves(fakeResponse({
                headers: { 'OData-EntityId': `${ENV_URL}/api/data/v9.2/webresourceset(not-a-guid)` },
            }));
            const client = new DataverseClient(fakeConnectionManager());

            await assert.rejects(
                () => client.createWebResource(params),
                /could not be determined/,
            );
        });

        it('rejects with an error including the status code on a non-ok response', async () => {
            fetchStub.resolves(fakeResponse({ ok: false, status: 400, statusText: 'Bad Request', text: async () => 'invalid' }));
            const client = new DataverseClient(fakeConnectionManager());

            await assert.rejects(
                () => client.createWebResource(params),
                (err: Error) => {
                    assert.match(err.message, /400/);
                    return true;
                },
            );
        });
    });

    // ── updateWebResourceContent ─────────────────────────────────────────

    describe('updateWebResourceContent', () => {
        it('issues a PATCH request with the correct body and returns nothing', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '' }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.updateWebResourceContent('wr-1', 'bmV3Y29udGVudA==');

            assert.strictEqual(result, undefined);
            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/webresourceset(wr-1)`);
            assert.strictEqual(requestInit.method, 'PATCH');
            assert.deepStrictEqual(JSON.parse(requestInit.body), { content: 'bmV3Y29udGVudA==' });
        });

        it('rejects with an error including the status code on a non-ok response', async () => {
            fetchStub.resolves(fakeResponse({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'missing' }));
            const client = new DataverseClient(fakeConnectionManager());

            await assert.rejects(
                () => client.updateWebResourceContent('wr-1', 'xxx'),
                (err: Error) => {
                    assert.match(err.message, /404/);
                    assert.match(err.message, /missing/);
                    return true;
                },
            );
        });
    });

    // ── publishWebResources ──────────────────────────────────────────────

    describe('publishWebResources', () => {
        it('is a no-op for an empty array', async () => {
            const client = new DataverseClient(fakeConnectionManager());
            await client.publishWebResources([]);
            assert.strictEqual(fetchStub.callCount, 0);
        });

        it('builds the PublishXml parameter payload and POSTs to the PublishXml endpoint', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '' }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.publishWebResources(['id-1', 'id-2']);

            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/PublishXml`);
            assert.strictEqual(requestInit.method, 'POST');
            const body = JSON.parse(requestInit.body);
            assert.strictEqual(
                body.ParameterXml,
                '<importexportxml><webresources><webresource>id-1</webresource><webresource>id-2</webresource></webresources></importexportxml>',
            );
        });
    });

    // ── addSolutionComponent ─────────────────────────────────────────────

    describe('addSolutionComponent', () => {
        it('defaults ComponentType to 61 (Web Resource) and includes the other fixed fields', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '' }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.addSolutionComponent('comp-1', 'MySolution');

            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/AddSolutionComponent`);
            assert.strictEqual(requestInit.method, 'POST');
            assert.deepStrictEqual(JSON.parse(requestInit.body), {
                ComponentId: 'comp-1',
                ComponentType: 61,
                SolutionUniqueName: 'MySolution',
                AddRequiredComponents: false,
                DoNotIncludeSubcomponents: false,
            });
        });

        it('accepts an explicit ComponentType (e.g. 1 for Entity)', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '' }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.addSolutionComponent('entity-metadata-id', 'MySolution', 1);

            const [, requestInit] = fetchStub.firstCall.args;
            const body = JSON.parse(requestInit.body);
            assert.strictEqual(body.ComponentType, 1);
        });
    });

    // ── getPublishers ─────────────────────────────────────────────────────

    describe('getPublishers', () => {
        it('requests only non-readonly publishers and maps fields', async () => {
            fetchStub.resolves(fakeResponse({
                json: async () => ({
                    value: [
                        { publisherid: 'pub-1', uniquename: 'mypublisher', friendlyname: 'My Publisher' },
                    ],
                }),
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getPublishers();

            const [url] = fetchStub.firstCall.args;
            assert.match(url, /\$filter=isreadonly eq false/);
            assert.deepStrictEqual(result, [{ publisherId: 'pub-1', uniqueName: 'mypublisher', friendlyName: 'My Publisher' }]);
        });
    });

    // ── importSolution ───────────────────────────────────────────────────

    describe('importSolution', () => {
        it('POSTs the zip and fixed import parameters to the ImportSolution action', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '' }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.importSolution('base64zip', 'job-guid-1');

            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/ImportSolution`);
            assert.strictEqual(requestInit.method, 'POST');
            assert.deepStrictEqual(JSON.parse(requestInit.body), {
                CustomizationFile: 'base64zip',
                OverwriteUnmanagedCustomizations: true,
                PublishWorkflows: false,
                ImportJobId: 'job-guid-1',
            });
        });
    });

    // ── getImportJobResult ───────────────────────────────────────────────

    describe('getImportJobResult', () => {
        it('reports not completed when completedon is null, without inspecting data', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ completedon: null, data: null }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getImportJobResult('job-guid-1');

            const [url] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/importjobs(job-guid-1)?$select=completedon,data`);
            assert.deepStrictEqual(result, { completed: false, success: false });
        });

        it('reports success when the root succeeded="true" and there is no failing result node', async () => {
            const data = '<importexportxml succeeded="true"><solutionManifest><UniqueName>test</UniqueName><result result="success" /></solutionManifest></importexportxml>';
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ completedon: '2024-01-01T00:00:00Z', data }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getImportJobResult('job-guid-1');

            assert.deepStrictEqual(result, { completed: true, success: true, warningText: undefined });
        });

        it('reports failure with the errortext when the root succeeded="false"', async () => {
            const data = '<importexportxml succeeded="false"><solutionManifest><UniqueName>test</UniqueName>'
                + '<result result="failure" errorcode="0x80040216" errortext="Something went wrong" />'
                + '</solutionManifest></importexportxml>';
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ completedon: '2024-01-01T00:00:00Z', data }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getImportJobResult('job-guid-1');

            assert.deepStrictEqual(result, { completed: true, success: false, errorText: 'Something went wrong' });
        });

        it('reports failure when the root succeeded attribute is missing entirely (ambiguous -- defaults to failure, not success)', async () => {
            const data = '<importexportxml><solutionManifest><UniqueName>test</UniqueName><result result="success" /></solutionManifest></importexportxml>';
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ completedon: '2024-01-01T00:00:00Z', data }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getImportJobResult('job-guid-1');

            assert.strictEqual(result.success, false);
        });

        it('reports success but surfaces a warningText when succeeded="warning" -- a non-fatal nested failure note must not block publishing', async () => {
            // Real shape confirmed against a live import: the overall root says "warning" (Dynamics'
            // own import history treats this as successful) even though a generic entity-level
            // dependency check logs its own non-fatal <result result="failure"> note, separate from
            // the ribbon subhandler that actually applied successfully.
            const data = '<importexportxml succeeded="warning">'
                + '<entities><entity id="tn_jctesttable" processed="false">'
                + '<result result="success" errorcode="0" errortext="" />'
                + '<result result="failure" errorcode="0x8004F105" errortext="The ribbon item \'x\' is dependent on &lt;CommandDefinition Id=&quot;y&quot; /&gt;." />'
                + '</entity></entities>'
                + '<entitySubhandlers><entityRibbon processed="true"><result result="success" errorcode="0" errortext="" /></entityRibbon></entitySubhandlers>'
                + '</importexportxml>';
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ completedon: '2024-01-01T00:00:00Z', data }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getImportJobResult('job-guid-1');

            assert.strictEqual(result.success, true);
            assert.match(result.warningText ?? '', /is dependent on/);
        });
    });

    // ── publishEntity ────────────────────────────────────────────────────

    describe('publishEntity', () => {
        it('POSTs a ParameterXml scoped to just the one entity', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '' }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.publishEntity('account');

            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/PublishXml`);
            const body = JSON.parse(requestInit.body);
            assert.strictEqual(body.ParameterXml, '<importexportxml><entities><entity>account</entity></entities></importexportxml>');
        });
    });

    // ── deleteSolution ───────────────────────────────────────────────────

    describe('deleteSolution', () => {
        it('sends a DELETE to the solution record', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '' }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.deleteSolution('sol-1');

            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/solutions(sol-1)`);
            assert.strictEqual(requestInit.method, 'DELETE');
        });
    });

    // ── createSolution ────────────────────────────────────────────────────

    describe('createSolution', () => {
        it('POSTs the expected body and parses the created id from the OData-EntityId header', async () => {
            const solutionId = '11111111-1111-1111-1111-111111111111';
            fetchStub.resolves(fakeResponse({
                headers: { 'OData-EntityId': `${ENV_URL}/api/data/v9.2/solutions(${solutionId})` },
            }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.createSolution('pub-1', 'myuniquename', 'My Friendly Name');

            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/solutions`);
            assert.strictEqual(requestInit.method, 'POST');
            assert.deepStrictEqual(JSON.parse(requestInit.body), {
                uniquename: 'myuniquename',
                friendlyname: 'My Friendly Name',
                version: '1.0.0.0',
                'publisherid@odata.bind': '/publishers(pub-1)',
            });
            assert.strictEqual(result, solutionId);
        });

        it('throws when the OData-EntityId header is missing', async () => {
            fetchStub.resolves(fakeResponse());
            const client = new DataverseClient(fakeConnectionManager());
            await assert.rejects(() => client.createSolution('pub-1', 'x', 'y'));
        });
    });

    // ── exportSolution ────────────────────────────────────────────────────

    describe('exportSolution', () => {
        it('POSTs SolutionName/Managed and decodes the base64 ExportSolutionFile', async () => {
            const zip = buildZip([{ name: 'solution.xml', content: Buffer.from('<xml/>', 'utf8'), method: 0 }]);
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ ExportSolutionFile: zip.toString('base64') }) }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.exportSolution('myuniquename');

            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/ExportSolution`);
            assert.deepStrictEqual(JSON.parse(requestInit.body), { SolutionName: 'myuniquename', Managed: false });
            assert.deepStrictEqual(result, zip);
        });

        it('throws when no ExportSolutionFile is returned', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({}) }));
            const client = new DataverseClient(fakeConnectionManager());
            await assert.rejects(() => client.exportSolution('myuniquename'));
        });
    });

    // ── getEntityCurrentRibbonDiffXml ─────────────────────────────────────

    describe('getEntityCurrentRibbonDiffXml', () => {
        function customizationsZipBase64(entityXmlInner: string): string {
            const customizationsXml = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml><Entities><Entity>${entityXmlInner}</Entity></Entities></ImportExportXml>`;
            return buildZip([{ name: 'customizations.xml', content: Buffer.from(customizationsXml, 'utf8'), method: 0 }]).toString('base64');
        }

        it('creates a temp solution, adds the entity (type 1), exports, extracts RibbonDiffXml, then deletes the temp solution', async () => {
            const solutionId = '22222222-2222-2222-2222-222222222222';
            const exportBase64 = customizationsZipBase64(
                '<Name>tn_jctesttable</Name><RibbonDiffXml><CustomActions><CustomAction Id="existing.Custom" Location="X" Sequence="1"><CommandUIDefinition><Button Id="existing" /></CommandUIDefinition></CustomAction></CustomActions></RibbonDiffXml>',
            );

            fetchStub.onCall(0).resolves(fakeResponse({ headers: { 'OData-EntityId': `${ENV_URL}/api/data/v9.2/solutions(${solutionId})` } })); // createSolution
            fetchStub.onCall(1).resolves(fakeResponse({ text: async () => '' })); // addSolutionComponent
            fetchStub.onCall(2).resolves(fakeResponse({ text: async () => JSON.stringify({ ExportSolutionFile: exportBase64 }) })); // exportSolution
            fetchStub.onCall(3).resolves(fakeResponse({ text: async () => '' })); // deleteSolution

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getEntityCurrentRibbonDiffXml('tn_jctesttable', 'entity-metadata-id', 'pub-1');

            assert.ok(result?.includes('existing.Custom'), 'should return the RibbonDiffXml containing the existing customization');

            // addSolutionComponent used Entity (1) with the given metadata id.
            const addComponentBody = JSON.parse(fetchStub.getCall(1).args[1].body);
            assert.strictEqual(addComponentBody.ComponentId, 'entity-metadata-id');
            assert.strictEqual(addComponentBody.ComponentType, 1);

            // The temporary solution was cleaned up.
            const [deleteUrl, deleteInit] = fetchStub.getCall(3).args;
            assert.strictEqual(deleteUrl, `${ENV_URL}/api/data/v9.2/solutions(${solutionId})`);
            assert.strictEqual(deleteInit.method, 'DELETE');
        });

        it('returns undefined when the entity has no existing RibbonDiffXml', async () => {
            const solutionId = '33333333-3333-3333-3333-333333333333';
            const exportBase64 = customizationsZipBase64('<Name>tn_jctesttable</Name>');

            fetchStub.onCall(0).resolves(fakeResponse({ headers: { 'OData-EntityId': `${ENV_URL}/api/data/v9.2/solutions(${solutionId})` } }));
            fetchStub.onCall(1).resolves(fakeResponse({ text: async () => '' }));
            fetchStub.onCall(2).resolves(fakeResponse({ text: async () => JSON.stringify({ ExportSolutionFile: exportBase64 }) }));
            fetchStub.onCall(3).resolves(fakeResponse({ text: async () => '' }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getEntityCurrentRibbonDiffXml('tn_jctesttable', 'entity-metadata-id', 'pub-1');

            assert.strictEqual(result, undefined);
        });

        it('still deletes the temporary solution even when exportSolution fails', async () => {
            const solutionId = '44444444-4444-4444-4444-444444444444';
            fetchStub.onCall(0).resolves(fakeResponse({ headers: { 'OData-EntityId': `${ENV_URL}/api/data/v9.2/solutions(${solutionId})` } }));
            fetchStub.onCall(1).resolves(fakeResponse({ text: async () => '' }));
            fetchStub.onCall(2).resolves(fakeResponse({ ok: false, status: 500, text: async () => 'boom' }));
            fetchStub.onCall(3).resolves(fakeResponse({ text: async () => '' }));

            const client = new DataverseClient(fakeConnectionManager());
            await assert.rejects(() => client.getEntityCurrentRibbonDiffXml('tn_jctesttable', 'entity-metadata-id', 'pub-1'));

            assert.strictEqual(fetchStub.callCount, 4, 'deleteSolution should still be attempted after a failure');
            const [deleteUrl, deleteInit] = fetchStub.getCall(3).args;
            assert.strictEqual(deleteUrl, `${ENV_URL}/api/data/v9.2/solutions(${solutionId})`);
            assert.strictEqual(deleteInit.method, 'DELETE');
        });
    });

    // ── regenerateAllRibbonMetadata ──────────────────────────────────────

    describe('regenerateAllRibbonMetadata', () => {
        it('POSTs to RegenerateRibbonMetadataForAllEntities with no body', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => '{"@odata.context":"...","StatusCode":201}' }));
            const client = new DataverseClient(fakeConnectionManager());
            await client.regenerateAllRibbonMetadata();

            const [url, requestInit] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/api/data/v9.2/RegenerateRibbonMetadataForAllEntities`);
            assert.strictEqual(requestInit.method, 'POST');
            assert.strictEqual(requestInit.body, undefined, 'the real action takes no parameters -- confirmed against a live capture (content-length: 0)');
        });
    });

    // ── getLatestRibbonMetadataGenerationRun ─────────────────────────────

    describe('getLatestRibbonMetadataGenerationRun', () => {
        it('filters by operation=7 (RibbonMetadataGeneration) and the given start time', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const since = new Date('2026-07-16T10:00:00.000Z');
            await client.getLatestRibbonMetadataGenerationRun(since);

            const [url] = fetchStub.firstCall.args;
            assert.strictEqual(
                url,
                `${ENV_URL}/api/data/v9.2/msdyn_solutionhistories?$select=msdyn_status,msdyn_result,msdyn_exceptionmessage` +
                `&$filter=msdyn_operation eq 7 and msdyn_starttime ge 2026-07-16T10:00:00.000Z` +
                `&$orderby=msdyn_starttime desc&$top=1`,
            );
        });

        it('returns undefined when no matching row exists yet', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getLatestRibbonMetadataGenerationRun(new Date());
            assert.strictEqual(result, undefined);
        });

        it('maps a Started row', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({
                value: [{ msdyn_status: 0, msdyn_result: null, msdyn_exceptionmessage: null }],
            }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getLatestRibbonMetadataGenerationRun(new Date());
            assert.deepStrictEqual(result, { status: 'Started', result: undefined, exceptionMessage: undefined });
        });

        it('maps a Completed/Success row', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({
                value: [{ msdyn_status: 1, msdyn_result: true, msdyn_exceptionmessage: null }],
            }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getLatestRibbonMetadataGenerationRun(new Date());
            assert.deepStrictEqual(result, { status: 'Completed', result: 'Success', exceptionMessage: undefined });
        });

        it('maps a Completed/Failure row with an exception message', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({
                value: [{ msdyn_status: 1, msdyn_result: false, msdyn_exceptionmessage: 'Something broke' }],
            }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getLatestRibbonMetadataGenerationRun(new Date());
            assert.deepStrictEqual(result, { status: 'Completed', result: 'Failure', exceptionMessage: 'Something broke' });
        });

        it('maps a Queued row', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({
                value: [{ msdyn_status: 2, msdyn_result: null, msdyn_exceptionmessage: null }],
            }) }));
            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getLatestRibbonMetadataGenerationRun(new Date());
            assert.deepStrictEqual(result, { status: 'Queued', result: undefined, exceptionMessage: undefined });
        });
    });

    // ── getEntityRibbonXml ───────────────────────────────────────────────

    describe('getEntityRibbonXml', () => {
        it('defaults to RibbonLocationFilter=All when no location filter is given, and decompresses the result', async () => {
            const xml = '<RibbonDefinitions><RibbonXml><Tabs/></RibbonXml></RibbonDefinitions>';
            const compressed = zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ CompressedEntityXml: compressed }) }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getEntityRibbonXml('account');

            assert.strictEqual(fetchStub.callCount, 1);
            const [url] = fetchStub.firstCall.args;
            assert.strictEqual(
                url,
                `${ENV_URL}/api/data/v9.2/RetrieveEntityRibbon(EntityName='account',RibbonLocationFilter=Microsoft.Dynamics.CRM.RibbonLocationFilters'All')`,
            );
            assert.strictEqual(result, xml);
        });

        for (const locationFilter of ['Form', 'HomepageGrid', 'SubGrid'] as const) {
            it(`scopes the request to RibbonLocationFilter=${locationFilter} when given`, async () => {
                const xml = '<RibbonDefinitions><RibbonXml><Tabs/></RibbonXml></RibbonDefinitions>';
                const compressed = zlib.gzipSync(Buffer.from(xml, 'utf8')).toString('base64');
                fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ CompressedEntityXml: compressed }) }));

                const client = new DataverseClient(fakeConnectionManager());
                await client.getEntityRibbonXml('account', locationFilter);

                const [url] = fetchStub.firstCall.args;
                assert.strictEqual(
                    url,
                    `${ENV_URL}/api/data/v9.2/RetrieveEntityRibbon(EntityName='account',RibbonLocationFilter=Microsoft.Dynamics.CRM.RibbonLocationFilters'${locationFilter}')`,
                );
            });
        }

        it('decodes a UTF-16LE (BOM) decompressed payload correctly', async () => {
            const xml = '<RibbonDefinitions><RibbonXml><Tabs/></RibbonXml></RibbonDefinitions>';
            const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
            const compressed = zlib.gzipSync(utf16).toString('base64');
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ CompressedEntityXml: compressed }) }));

            const client = new DataverseClient(fakeConnectionManager());
            const result = await client.getEntityRibbonXml('account');

            assert.strictEqual(result, xml);
        });

        it('throws when no CompressedEntityXml is returned', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({}) }));
            const client = new DataverseClient(fakeConnectionManager());
            await assert.rejects(() => client.getEntityRibbonXml('account'), /No ribbon XML returned/);
        });
    });

    // ── getRibbonImageContent ──────────────────────────────────────────────

    describe('getRibbonImageContent', () => {
        it('resolves a $webresource: reference via getWebResourceContentByName and wraps it as a data URI, sniffing the mime type from the actual bytes', async () => {
            const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [{ content: pngBase64 }] }) }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('$webresource:new_icon.png');

            assert.strictEqual(result, `data:image/png;base64,${pngBase64}`);
            const [url] = fetchStub.firstCall.args;
            assert.ok(url.includes(`name eq 'new_icon.png'`));
        });

        it('sniffs SVG/text content even when the web resource name has no file extension at all -- a real Dataverse web resource name isn\'t required to end in one', async () => {
            // Confirmed bug: guessing the mime type from the name (mimeTypeFor) defaulted a
            // no-extension name to image/png regardless of actual content, producing a broken image
            // in this editor's preview for an icon that rendered fine in Dynamics itself (which
            // resolves content type from the web resource's own webresourcetype column, not its name).
            const svgBase64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf8').toString('base64');
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [{ content: svgBase64 }] }) }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('$webresource:tn_RequestInformation');

            assert.strictEqual(result, `data:image/svg+xml;base64,${svgBase64}`);
        });

        it('returns undefined when the $webresource: reference does not exist', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('$webresource:missing.png');
            assert.strictEqual(result, undefined);
        });

        it('fetches a relative system icon path directly with a bearer token and wraps it as a data URI', async () => {
            // TextEncoder allocates a dedicated (non-pooled) ArrayBuffer, so this exactly matches the
            // 'hello' bytes -- Buffer.from(string) can return a view into Node's shared 8KB pool,
            // which would make response.arrayBuffer() include unrelated bytes.
            fetchStub.resolves(fakeResponse({ arrayBuffer: async () => new TextEncoder().encode('hello').buffer }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('/_imgs/ribbon/DeleteSelected_32.png');

            assert.strictEqual(result, `data:image/png;base64,${Buffer.from('hello').toString('base64')}`);
            const [url, init] = fetchStub.firstCall.args;
            assert.strictEqual(url, `${ENV_URL}/_imgs/ribbon/DeleteSelected_32.png`);
            assert.strictEqual(init.headers.Authorization, `Bearer ${TOKEN}`);
        });

        it('returns undefined when the system icon fetch is not ok', async () => {
            fetchStub.resolves(fakeResponse({ ok: false, status: 404 }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('/_imgs/ribbon/Missing_32.png');
            assert.strictEqual(result, undefined);
        });

        // A bare name (neither $webresource:-prefixed nor a relative system path) is how a custom
        // ModernImage is stored -- resolved as a web resource lookup by name, same as the
        // $webresource: case just without stripping a prefix first.
        it('resolves a bare name (e.g. a custom ModernImage) via getWebResourceContentByName', async () => {
            const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [{ content: pngBase64 }] }) }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('new_customicon');

            assert.strictEqual(result, `data:image/png;base64,${pngBase64}`);
            const [url] = fetchStub.firstCall.args;
            assert.ok(url.includes(`name eq 'new_customicon'`));
        });

        // Most ModernImage values are one of Dataverse's built-in Fluent icon names (e.g. "New",
        // "Refresh") rather than a web resource -- the lookup above simply finds nothing for these.
        it('returns undefined for a bare name that matches no web resource (e.g. a built-in Fluent icon name)', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [] }) }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('Refresh');
            assert.strictEqual(result, undefined);
        });
    });
});

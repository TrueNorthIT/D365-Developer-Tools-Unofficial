import * as assert from 'assert';
import * as sinon from 'sinon';
import * as zlib from 'zlib';
import { DataverseClient } from '../../src/dataverseClient';
import type { ConnectionManager } from '../../src/connectionManager';

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
        it('POSTs a body including ComponentType 61 and the other fixed fields', async () => {
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
            });
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
        it('resolves a $webresource: reference via getWebResourceContentByName and wraps it as a data URI', async () => {
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [{ content: 'QUJD' }] }) }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('$webresource:new_icon.png');

            assert.strictEqual(result, 'data:image/png;base64,QUJD');
            const [url] = fetchStub.firstCall.args;
            assert.ok(url.includes(`name eq 'new_icon.png'`));
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
            fetchStub.resolves(fakeResponse({ text: async () => JSON.stringify({ value: [{ content: 'QUJD' }] }) }));
            const client = new DataverseClient(fakeConnectionManager());

            const result = await client.getRibbonImageContent('new_customicon');

            assert.strictEqual(result, 'data:image/png;base64,QUJD');
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

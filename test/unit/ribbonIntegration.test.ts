import * as assert from 'assert';
import * as sinon from 'sinon';
import * as zlib from 'zlib';
import { DataverseClient } from '../../src/dataverseClient';
import { parseRibbonXml } from '../../src/ribbon/ribbonXmlParser';
import { buildZip } from '../helpers/zip';
import type { ConnectionManager } from '../../src/connectionManager';

// End-to-end test of the real ribbon-loading pipeline (DataverseClient.getEntityRibbonXml ->
// parseRibbonXml), using a payload shaped exactly like what Dataverse actually returns: a ZIP/OPC
// package whose entries are, in order, "RibbonXml.xml" then "[Content_Types].xml" — confirmed
// against a real environment. This is what would have caught both the ZIP-vs-gzip mismatch and the
// "grabbed the wrong entry" bug that the narrower unit tests (decompressRibbon.test.ts,
// ribbonXmlParser.test.ts) each missed in isolation, since neither exercises the full round trip.

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

const FIXTURE_XML = `<RibbonDefinitions>
  <RibbonXml>
    <Tabs>
      <Tab Id="Mscrm.form.account.MainTab" Title="Home">
        <Groups>
          <Group Id="grp.currency" Title="My Group">
            <Controls>
              <Button Id="new_button" LabelText="$LocLabels:loc1" ToolTipTitle="Click" Command="cmd1" />
            </Controls>
          </Group>
        </Groups>
      </Tab>
    </Tabs>
    <CommandDefinitions>
      <CommandDefinition Id="cmd1">
        <EnableRules>
          <EnableRule Id="rule.enable1" />
        </EnableRules>
        <Actions>
          <JavaScriptFunction Library="$webresource:new_lib.js" FunctionName="doThing">
            <StringParameter Value="hello" />
          </JavaScriptFunction>
        </Actions>
      </CommandDefinition>
    </CommandDefinitions>
    <RuleDefinitions>
      <EnableRules>
        <EnableRule Id="rule.enable1">
          <CrmClientTypeRule Type="Web" />
        </EnableRule>
      </EnableRules>
    </RuleDefinitions>
  </RibbonXml>
  <LocLabels>
    <LocLabel Id="loc1">
      <Titles>
        <Title description="Click Me" languagecode="1033" />
      </Titles>
    </LocLabel>
  </LocLabels>
</RibbonDefinitions>`;

// Builds the exact payload shape RetrieveEntityRibbon returns: a base64-encoded ZIP/OPC package
// with a "RibbonXml.xml" part (optionally BOM-encoded) alongside an unrelated "[Content_Types].xml"
// part that a naive "just take the first entry" reader would grab instead.
function buildCompressedEntityXml(xml: string, encoding: 'utf8' | 'utf16le-bom'): string {
    const content = encoding === 'utf16le-bom'
        ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')])
        : Buffer.from(xml, 'utf8');

    const zip = buildZip([
        { name: 'RibbonXml.xml', content, method: 8 },
        { name: '[Content_Types].xml', content: Buffer.from('<Types xmlns="urn:opc"/>', 'utf8'), method: 0 },
    ]);
    return zip.toString('base64');
}

describe('ribbon loading integration (DataverseClient.getEntityRibbonXml -> parseRibbonXml)', () => {
    let fetchStub: sinon.SinonStub;

    beforeEach(() => {
        fetchStub = sinon.stub(global, 'fetch');
    });

    afterEach(() => {
        sinon.restore();
    });

    for (const encoding of ['utf8', 'utf16le-bom'] as const) {
        it(`loads and parses a realistic UTF-8/ZIP payload (encoding: ${encoding})`, async () => {
            const compressed = buildCompressedEntityXml(FIXTURE_XML, encoding);
            fetchStub.resolves(fakeResponse(JSON.stringify({ CompressedEntityXml: compressed })));

            const client = new DataverseClient(fakeConnectionManager());
            const xml = await client.getEntityRibbonXml('account');
            const model = parseRibbonXml(xml);

            assert.strictEqual(model.tabs.length, 1);
            const tab = model.tabs[0];
            assert.strictEqual(tab.id, 'Mscrm.form.account.MainTab');
            assert.strictEqual(tab.title, 'Home');

            assert.strictEqual(tab.groups.length, 1);
            const group = tab.groups[0];
            assert.strictEqual(group.title, 'My Group');

            assert.strictEqual(group.controls.length, 1);
            const button = group.controls[0];
            assert.strictEqual(button.kind, 'Button');
            assert.strictEqual(button.id, 'new_button');
            assert.strictEqual(button.label, 'Click Me'); // resolved via $LocLabels:loc1
            assert.strictEqual(button.commandId, 'cmd1');

            assert.strictEqual(model.commandDefinitions.length, 1);
            const cmd = model.commandDefinitions[0];
            assert.strictEqual(cmd.id, 'cmd1');
            assert.deepStrictEqual(cmd.enableRules, ['rule.enable1']);
            assert.deepStrictEqual(cmd.actions[0], {
                type: 'JavaScriptFunction',
                library: '$webresource:new_lib.js',
                functionName: 'doThing',
                params: ['hello'],
            });

            assert.strictEqual(model.enableRules.length, 1);
            assert.ok(model.enableRules[0].xml.includes('CrmClientTypeRule'));
        });
    }

    it('surfaces a clear error end-to-end when the ribbon action fails (e.g. a bad enum literal)', async () => {
        fetchStub.resolves({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            text: async () => '{"error":{"message":"is not a valid enumeration type constant."}}',
        } as unknown as Response);

        const client = new DataverseClient(fakeConnectionManager());
        await assert.rejects(
            () => client.getEntityRibbonXml('account'),
            /Dataverse API error 400.*enumeration type constant/,
        );
    });
});

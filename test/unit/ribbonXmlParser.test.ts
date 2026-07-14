import * as assert from 'assert';
import { parseRibbonXml } from '../../src/ribbon/ribbonXmlParser';

const FIXTURE = `
<RibbonDefinitions>
  <RibbonXml>
    <Tabs>
      <Tab Id="Mscrm.form.account.MainTab" Title="Home">
        <Groups>
          <Group Id="grp.currency" Title="My Group">
            <Controls>
              <Button Id="new_button" LabelText="$LocLabels:loc1" ToolTipTitle="Click" ToolTipDescription="Does a thing" Command="cmd1" Image16by16="$webresource:new_icon16.png" Image32by32="$webresource:new_icon32.png" ModernImage="Refresh" />
              <FlyoutAnchor Id="new_flyout" LabelText="More">
                <Menu>
                  <MenuSection Id="new_flyout.section1">
                    <Controls>
                      <Button Id="new_flyout_child" LabelText="Nested" Command="cmd2" />
                    </Controls>
                  </MenuSection>
                </Menu>
              </FlyoutAnchor>
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
        <DisplayRules>
          <DisplayRule Id="rule.display1" />
        </DisplayRules>
        <Actions>
          <JavaScriptFunction Library="$webresource:new_lib.js" FunctionName="doThing">
            <StringParameter Value="hello" />
            <CrmParameter Value="PrimaryControl" />
          </JavaScriptFunction>
        </Actions>
      </CommandDefinition>
      <CommandDefinition Id="cmd2">
        <Actions>
          <Url Address="https://example.com" />
        </Actions>
      </CommandDefinition>
    </CommandDefinitions>
    <RuleDefinitions>
      <EnableRules>
        <EnableRule Id="rule.enable1">
          <CrmClientTypeRule Type="Web" />
        </EnableRule>
      </EnableRules>
      <DisplayRules>
        <DisplayRule Id="rule.display1">
          <CustomRule Library="$webresource:new_lib.js" FunctionName="isVisible" />
        </DisplayRule>
      </DisplayRules>
    </RuleDefinitions>
  </RibbonXml>
  <LocLabels>
    <LocLabel Id="loc1">
      <Titles>
        <Title description="Click Me" languagecode="1033" />
        <Title description="Cliquez-moi" languagecode="1036" />
      </Titles>
    </LocLabel>
  </LocLabels>
</RibbonDefinitions>`;

describe('parseRibbonXml', () => {
    it('parses tabs, groups, and a simple button control', () => {
        const model = parseRibbonXml(FIXTURE);

        assert.strictEqual(model.tabs.length, 1);
        const tab = model.tabs[0];
        assert.strictEqual(tab.id, 'Mscrm.form.account.MainTab');
        assert.strictEqual(tab.title, 'Home');
        assert.strictEqual(tab.status, 'unchanged');

        assert.strictEqual(tab.groups.length, 1);
        const group = tab.groups[0];
        assert.strictEqual(group.id, 'grp.currency');
        assert.strictEqual(group.title, 'My Group');

        assert.strictEqual(group.controls.length, 2);
        const button = group.controls[0];
        assert.strictEqual(button.kind, 'Button');
        assert.strictEqual(button.id, 'new_button');
        assert.strictEqual(button.commandId, 'cmd1');
        assert.strictEqual(button.image16, '$webresource:new_icon16.png');
        assert.strictEqual(button.modernImage, 'Refresh');
        assert.strictEqual(button.toolTipDescription, 'Does a thing');
    });

    it('resolves $LocLabels references against the 1033 (or first) title', () => {
        const model = parseRibbonXml(FIXTURE);
        const button = model.tabs[0].groups[0].controls[0];
        assert.strictEqual(button.label, 'Click Me');
        assert.strictEqual(model.locLabels.loc1, 'Click Me');
    });

    it('parses nested FlyoutAnchor > Menu > MenuSection > Controls', () => {
        const model = parseRibbonXml(FIXTURE);
        const flyout = model.tabs[0].groups[0].controls[1];
        assert.strictEqual(flyout.kind, 'FlyoutAnchor');
        assert.strictEqual(flyout.controls?.length, 1);

        const section = flyout.controls![0];
        assert.strictEqual(section.kind, 'MenuSection');
        assert.strictEqual(section.controls?.length, 1);
        assert.strictEqual(section.controls![0].id, 'new_flyout_child');
    });

    it('parses command definitions with JavaScriptFunction and Url actions', () => {
        const model = parseRibbonXml(FIXTURE);
        assert.strictEqual(model.commandDefinitions.length, 2);

        const cmd1 = model.commandDefinitions.find(c => c.id === 'cmd1')!;
        assert.deepStrictEqual(cmd1.enableRules, ['rule.enable1']);
        assert.deepStrictEqual(cmd1.displayRules, ['rule.display1']);
        assert.strictEqual(cmd1.actions.length, 1);
        assert.deepStrictEqual(cmd1.actions[0], {
            type: 'JavaScriptFunction',
            library: '$webresource:new_lib.js',
            functionName: 'doThing',
            params: [{ type: 'StringParameter', value: 'hello' }, { type: 'CrmParameter', value: 'PrimaryControl' }],
        });

        const cmd2 = model.commandDefinitions.find(c => c.id === 'cmd2')!;
        assert.deepStrictEqual(cmd2.actions[0], { type: 'Url', address: 'https://example.com' });
    });

    it('keeps EnableRule/DisplayRule definitions as opaque XML fragments', () => {
        const model = parseRibbonXml(FIXTURE);
        assert.strictEqual(model.enableRules.length, 1);
        assert.strictEqual(model.enableRules[0].id, 'rule.enable1');
        assert.ok(model.enableRules[0].xml.includes('CrmClientTypeRule'));

        assert.strictEqual(model.displayRules.length, 1);
        assert.strictEqual(model.displayRules[0].id, 'rule.display1');
        assert.ok(model.displayRules[0].xml.includes('CustomRule'));
    });
});

import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { RibbonAction, RibbonControl, RibbonModel, RibbonNodeStatus, RibbonRuleRaw } from '../protocol';
import { findControl, findGroup, findTab, type Action, type Selection } from '../ribbonState';
import { parseRuleCondition, ruleConditionLabel } from '../ruleCondition';
import { RuleDialog } from './RuleDialog';
import { WebResourceField } from './WebResourceField';

interface Props {
  model: RibbonModel;
  selection: Selection;
  dispatch: Dispatch<Action>;
}

export function NodeEditor({ model, selection, dispatch }: Props) {
  if (!selection) {
    return <div className="node-editor empty">Select a tab, group, or button to edit it.</div>;
  }

  if (selection.kind === 'tab') {
    const tab = findTab(model, selection.id);
    if (!tab) { return null; }
    return (
      <div className="node-editor">
        <h3>Tab <StatusTag status={tab.status} /></h3>
        <label>Id<input type="text" value={tab.id} readOnly /></label>
        <label>Title<input type="text" value={tab.title} onChange={e => dispatch({ type: 'local/updateTab', id: tab.id, title: e.target.value })} /></label>
      </div>
    );
  }

  if (selection.kind === 'group') {
    const found = findGroup(model, selection.id);
    if (!found) { return null; }
    return (
      <div className="node-editor">
        <h3>Group <StatusTag status={found.group.status} /></h3>
        <label>Id<input type="text" value={found.group.id} readOnly /></label>
        <label>Title<input type="text" value={found.group.title} onChange={e => dispatch({ type: 'local/updateGroup', id: found.group.id, title: e.target.value })} /></label>
      </div>
    );
  }

  const control = findControl(model, selection.id);
  if (!control) { return null; }
  return (
    <div className="node-editor">
      <h3>{control.kind} <StatusTag status={control.status} /></h3>
      <label>Id<input type="text" value={control.id} readOnly /></label>
      <label>Label<input type="text" value={control.label} onChange={e => dispatch({ type: 'local/updateControl', id: control.id, patch: { label: e.target.value } })} /></label>
      <label>Tooltip title<input type="text" value={control.toolTipTitle} onChange={e => dispatch({ type: 'local/updateControl', id: control.id, patch: { toolTipTitle: e.target.value } })} /></label>
      <label>Tooltip description<textarea value={control.toolTipDescription} onChange={e => dispatch({ type: 'local/updateControl', id: control.id, patch: { toolTipDescription: e.target.value } })} /></label>
      <WebResourceField
        label="16×16 icon (web resource name or system path)"
        value={control.image16 ?? ''}
        onChange={v => dispatch({ type: 'local/updateControl', id: control.id, patch: { image16: v } })}
      />
      <WebResourceField
        label="32×32 icon (web resource name or system path)"
        value={control.image32 ?? ''}
        onChange={v => dispatch({ type: 'local/updateControl', id: control.id, patch: { image32: v } })}
      />
      <WebResourceField
        label="Modern icon (web resource name, or a built-in Fluent icon name)"
        value={control.modernImage ?? ''}
        onChange={v => dispatch({ type: 'local/updateControl', id: control.id, patch: { modernImage: v } })}
      />
      <label>Command Id<input type="text" value={control.commandId ?? ''} onChange={e => dispatch({ type: 'local/updateControl', id: control.id, patch: { commandId: e.target.value } })} /></label>

      <CommandSection model={model} control={control} dispatch={dispatch} />
    </div>
  );
}

// Only the command (and its enable/display rules) that THIS button actually references — not the
// full model-wide lists, which run into the hundreds on a real ribbon and were unusable to browse.
function CommandSection({ model, control, dispatch }: { model: RibbonModel; control: RibbonControl; dispatch: Dispatch<Action> }) {
  const command = control.commandId ? model.commandDefinitions.find(c => c.id === control.commandId) : undefined;

  if (!command) {
    return (
      <div className="command-section">
        <h4>Command</h4>
        {control.commandId
          ? <p className="hint">Command Id '{control.commandId}' was not found in this ribbon.</p>
          : <p className="hint">This control has no command yet.</p>}
        <button type="button" onClick={() => dispatch({ type: 'local/createCommandForControl', controlId: control.id })}>
          Create Command
        </button>
      </div>
    );
  }

  const action = command.actions[0];
  const enableRules = command.enableRules.map(id => model.enableRules.find(r => r.id === id)).filter(isDefined);
  const displayRules = command.displayRules.map(id => model.displayRules.find(r => r.id === id)).filter(isDefined);

  return (
    <div className="command-section">
      <h4>Command <StatusTag status={command.status} /></h4>
      <label>Command Id<input type="text" value={command.id} readOnly /></label>
      <label>Enable Rule Ids (comma-separated)
        <input
          type="text"
          value={command.enableRules.join(', ')}
          onChange={e => dispatch({ type: 'local/updateCommand', id: command.id, patch: { enableRules: splitIds(e.target.value) } })}
        />
      </label>
      <label>Display Rule Ids (comma-separated)
        <input
          type="text"
          value={command.displayRules.join(', ')}
          onChange={e => dispatch({ type: 'local/updateCommand', id: command.id, patch: { displayRules: splitIds(e.target.value) } })}
        />
      </label>

      {action?.type === 'Url' && <p className="hint">Action: URL → {action.address} (editing URL actions isn't supported yet — edit the JS fields below to replace it).</p>}
      {action?.type === 'Raw' && <p className="hint">Action preserved as-is (an advanced action type this editor doesn't model). Editing below replaces it with a JavaScript function.</p>}

      <WebResourceField
        label="JS Library (web resource name)"
        value={action?.type === 'JavaScriptFunction' ? action.library : ''}
        onChange={v => dispatch({
          type: 'local/updateCommand', id: command.id,
          action: jsAction(action, { library: v }),
        })}
      />
      <label>Function name
        <input
          type="text"
          value={action?.type === 'JavaScriptFunction' ? action.functionName : ''}
          onChange={e => dispatch({
            type: 'local/updateCommand', id: command.id,
            action: jsAction(action, { functionName: e.target.value }),
          })}
        />
      </label>
      <label>Parameters (comma-separated)
        <input
          type="text"
          value={action?.type === 'JavaScriptFunction' ? action.params.join(', ') : ''}
          onChange={e => dispatch({
            type: 'local/updateCommand', id: command.id,
            action: jsAction(action, { params: splitIds(e.target.value) }),
          })}
        />
      </label>

      <RuleGroup title="Enable Rules" rules={enableRules} referencedCount={command.enableRules.length} ruleType="enable" commandId={command.id} dispatch={dispatch} />
      <RuleGroup title="Display Rules" rules={displayRules} referencedCount={command.displayRules.length} ruleType="display" commandId={command.id} dispatch={dispatch} />
    </div>
  );
}

// Shown as compact, labelled tiles rather than always-expanded textareas -- a real command can
// reference several rules, and a raw XML fragment per rule doesn't need to be on screen until
// you're actually editing it. Clicking a tile (including a freshly-created one, opened
// automatically -- see the "just created" effect below) opens RuleDialog to view/edit/remove it.
function RuleGroup({ title, rules, referencedCount, ruleType, commandId, dispatch }: {
  title: string;
  rules: RibbonRuleRaw[];
  referencedCount: number;
  ruleType: 'enable' | 'display';
  commandId: string;
  dispatch: Dispatch<Action>;
}) {
  const [openRuleId, setOpenRuleId] = useState<string | undefined>(undefined);
  // This component instance stays mounted as the selected button/command changes (it's always
  // rendered in the same spot in CommandSection) -- so the rule count "increasing" only means "a
  // rule was just added to THIS command" when commandId hasn't also changed. Without that guard,
  // merely selecting a different button whose command happens to reference more rules than the
  // previous one falsely looked like a just-added rule and popped its dialog open.
  const prev = useRef({ commandId, count: rules.length });

  useEffect(() => {
    if (prev.current.commandId === commandId && rules.length > prev.current.count) {
      setOpenRuleId(rules[rules.length - 1].id);
    }
    prev.current = { commandId, count: rules.length };
  }, [commandId, rules]);

  const openRule = rules.find(r => r.id === openRuleId);

  return (
    <div className="rule-group">
      <div className="rule-group-header">
        <span>{title} ({rules.length})</span>
        <button type="button" onClick={() => dispatch({ type: 'local/addRuleToCommand', commandId, ruleType })}>+ New</button>
      </div>
      {referencedCount > rules.length && <p className="hint">Some referenced rule ids weren't found in this ribbon.</p>}
      <div className="rule-tiles">
        {rules.map(rule => (
          <button
            key={rule.id}
            type="button"
            className={'rule-tile' + statusSuffix(rule.status)}
            onClick={() => setOpenRuleId(rule.id)}
            title={rule.id}
          >
            <span className="rule-tile-name">{rule.id}</span>
            <span className="rule-tile-kind">{ruleConditionLabel(parseRuleCondition(rule.xml))}</span>
          </button>
        ))}
      </div>

      {openRule && (
        <RuleDialog
          title={title.replace(/s$/, '')}
          wrapperTag={ruleType === 'enable' ? 'EnableRule' : 'DisplayRule'}
          rule={openRule}
          onSave={xml => {
            dispatch({ type: 'local/updateRule', ruleType, id: openRule.id, xml });
            setOpenRuleId(undefined);
          }}
          onRemove={() => {
            dispatch({ type: 'local/removeRuleFromCommand', commandId, ruleType, ruleId: openRule.id });
            setOpenRuleId(undefined);
          }}
          onClose={() => setOpenRuleId(undefined)}
        />
      )}
    </div>
  );
}

function jsAction(current: RibbonAction | undefined, patch: Partial<{ library: string; functionName: string; params: string[] }>): RibbonAction {
  const base = current?.type === 'JavaScriptFunction' ? current : { library: '', functionName: '', params: [] as string[] };
  return { type: 'JavaScriptFunction', ...base, ...patch };
}

function isDefined<T>(v: T | undefined): v is T {
  return v !== undefined;
}

function statusSuffix(status: RibbonNodeStatus): string {
  return status === 'unchanged' ? '' : ` status-${status}`;
}

function StatusTag({ status }: { status: string }) {
  if (status === 'unchanged') { return null; }
  return <span className={`status-tag status-${status}`}>{status}</span>;
}

function splitIds(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

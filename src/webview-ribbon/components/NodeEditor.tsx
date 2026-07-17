import { useEffect, useRef, useState, type Dispatch } from 'react';
import type { RibbonAction, RibbonActionParameter, RibbonControl, RibbonModel, RibbonNodeStatus, RibbonRuleRaw } from '../protocol';
import { displayText, findControl, findGroup, findTab, type Action, type PromptRequest, type Selection } from '../ribbonState';
import { parseRuleCondition, ruleConditionLabel } from '../ruleCondition';
import { ParametersDialog } from './ParametersDialog';
import { PositionedMenu } from './PositionedMenu';
import { RuleDialog } from './RuleDialog';
import { WebResourceField } from './WebResourceField';

interface Props {
  model: RibbonModel;
  selection: Selection;
  dispatch: Dispatch<Action>;
  onRequestPrompt: (request: PromptRequest) => void;
}

export function NodeEditor({ model, selection, dispatch, onRequestPrompt }: Props) {
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
        <LabelLikeField label="Title" rawValue={tab.title} id={tab.id} onChange={v => dispatch({ type: 'local/updateTab', id: tab.id, title: v })} />
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
        <LabelLikeField label="Title" rawValue={found.group.title} id={found.group.id} onChange={v => dispatch({ type: 'local/updateGroup', id: found.group.id, title: v })} />
      </div>
    );
  }

  const control = findControl(model, selection.id);
  if (!control) { return null; }
  return (
    <div className="node-editor">
      <h3>{control.kind} <StatusTag status={control.status} /></h3>
      <label>Id<input type="text" value={control.id} readOnly /></label>
      <LabelLikeField label="Label" rawValue={control.label} id={control.id} onChange={v => dispatch({ type: 'local/updateControl', id: control.id, patch: { label: v } })} />
      <LabelLikeField label="Tooltip title" rawValue={control.toolTipTitle} id={control.id} onChange={v => dispatch({ type: 'local/updateControl', id: control.id, patch: { toolTipTitle: v } })} />
      <LabelLikeField label="Tooltip description" rawValue={control.toolTipDescription} id={control.id} onChange={v => dispatch({ type: 'local/updateControl', id: control.id, patch: { toolTipDescription: v } })} multiline />
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

      <CommandSection model={model} control={control} dispatch={dispatch} onRequestPrompt={onRequestPrompt} />
    </div>
  );
}

// Ribbon labels/titles are frequently unresolved $LocLabels:/$Resources: references -- the effective
// ribbon response ships no label dictionary to resolve them against (see ribbonXmlParser.ts), so
// they're stored verbatim as that raw reference string. Editing the raw reference directly isn't
// useful -- this starts the field from displayText()'s readable guess instead (the same one already
// shown in the read-only ribbon preview), so there's real text to edit rather than gibberish.
// Nothing is written back just from viewing it: the guess is only ever a *displayed* value:
// selecting a control and leaving its fields untouched never dispatches a change, so the
// underlying reference stays exactly as parsed until the user actually types something.
//
// Only an actual $LocLabels:/$Resources: reference gets the guess treatment -- displayText() also
// derives a guess for an *empty* value (so the read-only preview never shows a totally blank
// button), which would fight you here: backspacing a field down to blank would otherwise snap back
// to showing the guess on the next render instead of staying empty, making the field seem
// impossible to actually clear.
function LabelLikeField({ label, rawValue, id, onChange, multiline }: {
  label: string;
  rawValue: string;
  id: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}) {
  const isReference = rawValue.startsWith('$LocLabels:') || rawValue.startsWith('$Resources:');
  const shown = isReference ? displayText(rawValue, id) : rawValue;
  return (
    <>
      <label>{label}
        {multiline
          ? <textarea value={shown} onChange={e => onChange(e.target.value)} />
          : <input type="text" value={shown} onChange={e => onChange(e.target.value)} />}
      </label>
      {isReference && (
        <p className="hint">
          The real value is an unresolved $LocLabels:/$Resources: reference -- showing a guess derived from the Id above. Type to set the real value.
        </p>
      )}
    </>
  );
}

// Only the command (and its enable/display rules) that THIS button actually references — not the
// full model-wide lists, which run into the hundreds on a real ribbon and were unusable to browse.
function CommandSection({ model, control, dispatch, onRequestPrompt }: { model: RibbonModel; control: RibbonControl; dispatch: Dispatch<Action>; onRequestPrompt: (request: PromptRequest) => void }) {
  const [editingParams, setEditingParams] = useState(false);
  const command = control.commandId ? model.commandDefinitions.find(c => c.id === control.commandId) : undefined;

  if (!command) {
    return (
      <div className="command-section">
        <h4>Command</h4>
        {control.commandId
          ? <p className="hint">Command Id '{control.commandId}' was not found in this ribbon.</p>
          : <p className="hint">This control has no command yet.</p>}
        <button type="button" onClick={() => onRequestPrompt({ kind: 'command', controlId: control.id })}>
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

      <button type="button" className="full-width-button" onClick={() => setEditingParams(true)}>Edit Parameters…</button>

      {editingParams && (
        <ParametersDialog
          params={action?.type === 'JavaScriptFunction' ? action.params : []}
          onSave={params => {
            dispatch({ type: 'local/updateCommand', id: command.id, action: jsAction(action, { params }) });
            setEditingParams(false);
          }}
          onClose={() => setEditingParams(false)}
        />
      )}

      <RuleGroup title="Enable Rules" rules={enableRules} referencedCount={command.enableRules.length} ruleType="enable" commandId={command.id} dispatch={dispatch} onRequestPrompt={onRequestPrompt} />
      <RuleGroup title="Display Rules" rules={displayRules} referencedCount={command.displayRules.length} ruleType="display" commandId={command.id} dispatch={dispatch} onRequestPrompt={onRequestPrompt} />
    </div>
  );
}

function jsAction(current: RibbonAction | undefined, patch: Partial<{ library: string; functionName: string; params: RibbonActionParameter[] }>): RibbonAction {
  const base = current?.type === 'JavaScriptFunction' ? current : { library: '', functionName: '', params: [] as RibbonActionParameter[] };
  return { type: 'JavaScriptFunction', ...base, ...patch };
}

// Shown as compact, labelled tiles rather than always-expanded textareas -- a real command can
// reference several rules, and a raw XML fragment per rule doesn't need to be on screen until
// you're actually editing it. Clicking a tile (including a freshly-created one, opened
// automatically -- see the "just created" effect below) opens RuleDialog to view/edit/remove it.
function RuleGroup({ title, rules, referencedCount, ruleType, commandId, dispatch, onRequestPrompt }: {
  title: string;
  rules: RibbonRuleRaw[];
  referencedCount: number;
  ruleType: 'enable' | 'display';
  commandId: string;
  dispatch: Dispatch<Action>;
  onRequestPrompt: (request: PromptRequest) => void;
}) {
  const [openRuleId, setOpenRuleId] = useState<string | undefined>(undefined);
  const [ctxMenu, setCtxMenu] = useState<{ ruleId: string; x: number; y: number } | null>(null);
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

  const removeRule = (ruleId: string): void => {
    dispatch({ type: 'local/removeRuleFromCommand', commandId, ruleType, ruleId });
  };

  return (
    <div className="rule-group">
      <div className="rule-group-header">
        <span>{title} ({rules.length})</span>
        <button type="button" onClick={() => onRequestPrompt({ kind: 'rule', commandId, ruleType })}>+ New</button>
      </div>
      {referencedCount > rules.length && <p className="hint">Some referenced rule ids weren't found in this ribbon.</p>}
      <div className="rule-tiles">
        {rules.map(rule => (
          <button
            key={rule.id}
            type="button"
            className={'rule-tile' + statusSuffix(rule.status)}
            onClick={() => setOpenRuleId(rule.id)}
            onContextMenu={e => { e.preventDefault(); setCtxMenu({ ruleId: rule.id, x: e.clientX, y: e.clientY }); }}
            title={rule.id}
          >
            <span className="rule-tile-name">{rule.id}</span>
            <span className="rule-tile-kind">{ruleConditionLabel(parseRuleCondition(rule.xml))}</span>
          </button>
        ))}
      </div>

      {ctxMenu && (
        <PositionedMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          <button type="button" onClick={() => { setCtxMenu(null); removeRule(ctxMenu.ruleId); }}>Remove</button>
        </PositionedMenu>
      )}

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
            removeRule(openRule.id);
            setOpenRuleId(undefined);
          }}
          onClose={() => setOpenRuleId(undefined)}
        />
      )}
    </div>
  );
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

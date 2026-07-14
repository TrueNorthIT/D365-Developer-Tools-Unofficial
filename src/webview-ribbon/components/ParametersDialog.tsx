import { useEffect, useState } from 'react';
import type { RibbonActionParameter } from '../protocol';
import { CheckboxField, EnumField, TextField } from './FormFields';

interface Props {
  params: RibbonActionParameter[];
  onSave: (params: RibbonActionParameter[]) => void;
  onClose: () => void;
}

const PARAM_TYPES: RibbonActionParameter['type'][] = ['StringParameter', 'CrmParameter', 'BoolParameter', 'DecimalParameter', 'IntParameter'];

const PARAM_TYPE_LABELS: Record<RibbonActionParameter['type'], string> = {
  StringParameter: 'String Parameter',
  CrmParameter: 'CRM Parameter',
  BoolParameter: 'Boolean Parameter',
  DecimalParameter: 'Decimal Parameter',
  IntParameter: 'Integer Parameter',
};

// The 23 values of the schema's CrmParameterValue enumeration (RibbonTypes.xsd) -- what a
// CrmParameter's Value attribute is actually restricted to, unlike the other four parameter types
// whose Value is free-form.
const CRM_PARAMETER_VALUES = [
  'PrimaryEntityTypeCode', 'PrimaryEntityTypeName', 'PrimaryItemIds', 'FirstPrimaryItemId',
  'PrimaryControl', 'PrimaryControlId',
  'SelectedEntityTypeCode', 'SelectedEntityTypeName', 'FirstSelectedItemId',
  'SelectedControl', 'SelectedControlSelectedItemCount', 'SelectedControlSelectedItemIds', 'SelectedControlSelectedItemReferences',
  'SelectedControlAllItemCount', 'SelectedControlAllItemIds', 'SelectedControlAllItemReferences',
  'SelectedControlUnselectedItemCount', 'SelectedControlUnselectedItemIds', 'SelectedControlUnselectedItemReferences',
  'OrgName', 'OrgLcid', 'UserLcid', 'CommandProperties',
];

function defaultParam(type: RibbonActionParameter['type']): RibbonActionParameter {
  if (type === 'BoolParameter') { return { type, value: false }; }
  if (type === 'CrmParameter') { return { type, value: CRM_PARAMETER_VALUES[0] }; }
  return { type, value: '' };
}

// A dialog for editing a JavaScriptFunction action's Parameters list -- Library/Function name stay
// as inline fields in NodeEditor (like before), but Parameters needed to become an editable,
// per-item-typed list (a JS function call's arguments aren't just interchangeable strings:
// CrmParameter's Value is one of a fixed set of schema tokens, BoolParameter's is true/false, etc.
// -- see RibbonActionParameter in protocol.ts), which doesn't fit as an inline field. Follows the
// same "+ Add / per-item type dropdown / type-specific fields / remove" pattern already established
// in RuleDialog's OrRuleEditor/LeafConditionEditor for the same reason: a list whose items can each
// independently be one of several shapes.
export function ParametersDialog({ params: initialParams, onSave, onClose }: Props) {
  const [params, setParams] = useState<RibbonActionParameter[]>(initialParams);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const updateAt = (i: number, param: RibbonActionParameter) => {
    const next = params.slice();
    next[i] = param;
    setParams(next);
  };
  const removeAt = (i: number) => setParams(params.filter((_, idx) => idx !== i));
  const addParam = () => setParams([...params, defaultParam(PARAM_TYPES[0])]);
  const moveAt = (i: number, offset: -1 | 1) => {
    const j = i + offset;
    if (j < 0 || j >= params.length) { return; }
    const next = params.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setParams(next);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Edit Parameters</h3>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>

        <div className="item-list">
          <p className="hint">Parameters (in order) passed to the function.</p>
          {params.map((param, i) => (
            <ParamRow
              key={i}
              param={param}
              onChange={p => updateAt(i, p)}
              onRemove={() => removeAt(i)}
              onMoveUp={() => moveAt(i, -1)}
              onMoveDown={() => moveAt(i, 1)}
              canMoveUp={i > 0}
              canMoveDown={i < params.length - 1}
            />
          ))}
          <button type="button" onClick={addParam}>+ Add Parameter</button>
        </div>

        <div className="dialog-actions">
          <div className="dialog-actions-spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={() => onSave(params)}>Save</button>
        </div>
      </div>
    </div>
  );
}

function ParamRow({ param, onChange, onRemove, onMoveUp, onMoveDown, canMoveUp, canMoveDown }: {
  param: RibbonActionParameter;
  onChange: (param: RibbonActionParameter) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  return (
    <div className="item-row">
      <div className="item-row-header">
        <select value={param.type} onChange={e => onChange(defaultParam(e.target.value as RibbonActionParameter['type']))}>
          {PARAM_TYPES.map(t => <option key={t} value={t}>{PARAM_TYPE_LABELS[t]}</option>)}
        </select>
        <button type="button" className="item-row-move" onClick={onMoveUp} disabled={!canMoveUp} aria-label="Move parameter up" title="Move up">▲</button>
        <button type="button" className="item-row-move" onClick={onMoveDown} disabled={!canMoveDown} aria-label="Move parameter down" title="Move down">▼</button>
        <button type="button" className="item-row-remove" onClick={onRemove} aria-label="Remove parameter" title="Remove parameter">✕</button>
      </div>
      <ParamValueField param={param} onChange={onChange} />
    </div>
  );
}

function ParamValueField({ param, onChange }: { param: RibbonActionParameter; onChange: (param: RibbonActionParameter) => void }) {
  switch (param.type) {
    case 'BoolParameter':
      return <CheckboxField label="Value" checked={param.value} onChange={v => onChange({ ...param, value: v })} />;
    case 'CrmParameter':
      return <EnumField label="Value" value={param.value} options={CRM_PARAMETER_VALUES} onChange={v => onChange({ ...param, value: v })} />;
    case 'DecimalParameter':
    case 'IntParameter':
      return <label>Value<input type="number" value={param.value} onChange={e => onChange({ ...param, value: e.target.value })} /></label>;
    case 'StringParameter':
      return <TextField label="Value" value={param.value} onChange={v => onChange({ ...param, value: v })} />;
  }
}

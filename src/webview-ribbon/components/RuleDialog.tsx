import { useEffect, useState } from 'react';
import type { RibbonRuleRaw } from '../protocol';
import {
  APPLIES_TO_OPTIONS,
  CLIENT_TYPES,
  COMMAND_CLIENT_TYPES,
  defaultLeafCondition,
  defaultRuleCondition,
  ENTITY_PROPERTY_NAMES,
  ENTITY_RULE_CONTEXTS,
  FORM_STATES,
  FORM_TYPES,
  leafRuleTypesFor,
  OFFLINE_ACCESS_STATES,
  ORGANIZATION_SETTINGS,
  OUTLOOK_CLIENT_TYPES,
  OUTLOOK_VERSIONS,
  parseRuleCondition,
  PRIVILEGE_DEPTHS,
  PRIVILEGE_DEPTHS_WITH_NONE,
  PRIVILEGE_TYPES,
  RELATIONSHIP_TYPES,
  ruleTypesFor,
  RULE_CONDITION_LABELS,
  serializeRuleCondition,
  SKUS,
  type RibbonRuleCondition,
  type RibbonRuleConditionType,
  type RibbonRuleLeafCondition,
  type RibbonRuleLeafConditionType,
} from '../ruleCondition';

interface Props {
  title: string;
  wrapperTag: 'EnableRule' | 'DisplayRule';
  rule: RibbonRuleRaw;
  onSave: (xml: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

// A modal for viewing/editing one enable/display rule, opened from its tile in NodeEditor.tsx's
// rule list (both for a newly-created rule and an existing one) rather than editing inline -- a
// ribbon can reference dozens of rules per command, so keeping them as compact tiles until you
// actually need to touch one scales far better than always-expanded textareas.
//
// The "Rule Type" dropdown drives which structured, mostly-dropdown fields show below it -- and is
// itself scoped to only the condition types actually valid for this rule's wrapper (EnableRule vs
// DisplayRule accept different condition sets per the schema; see ruleCondition.ts). Switching types
// re-parses the current raw XML against the newly chosen type first, so hand-typed XML that already
// matches isn't discarded -- only a genuine type change resets to that type's defaults.
//
// "Any Of (Or)" is the schema's composite: true if ANY of several nested leaf conditions is true.
// It renders a list of the same type-dropdown-plus-fields editor recursively (OrRuleEditor /
// LeafConditionEditor below), one level deep -- the schema doesn't nest Or inside Or either.
export function RuleDialog({ title, wrapperTag, rule, onSave, onRemove, onClose }: Props) {
  const [condition, setCondition] = useState<RibbonRuleCondition>(() => parseRuleCondition(rule.xml));
  const [showXml, setShowXml] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The types actually valid for this wrapper, plus the rule's current type if it happens to fall
  // outside that list (e.g. hand-authored XML using a type this bucket doesn't officially support,
  // or Raw) -- so the dropdown never silently hides what the rule already is.
  const availableTypes = ruleTypesFor(wrapperTag);
  const typeOptions = availableTypes.includes(condition.type) ? availableTypes : [condition.type, ...availableTypes];

  const handleTypeChange = (nextType: RibbonRuleConditionType) => {
    if (nextType === 'Raw') {
      const xml = condition.type === 'Raw' ? condition.xml : serializeRuleCondition(rule.id, wrapperTag, condition);
      setCondition({ type: 'Raw', xml });
      return;
    }
    const reparsed = condition.type === 'Raw' ? parseRuleCondition(condition.xml) : condition;
    setCondition(reparsed.type === nextType ? reparsed : defaultRuleCondition(nextType));
  };

  const handleSave = () => onSave(serializeRuleCondition(rule.id, wrapperTag, condition));

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{title}</h3>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>

        <label>Id<input type="text" value={rule.id} readOnly /></label>
        <label>Rule Type
          <select value={condition.type} onChange={e => handleTypeChange(e.target.value as RibbonRuleConditionType)}>
            {typeOptions.map(t => <option key={t} value={t}>{RULE_CONDITION_LABELS[t]}</option>)}
          </select>
        </label>

        {condition.type === 'Raw' ? (
          <label>XML
            <textarea className="raw-xml" value={condition.xml} onChange={e => setCondition({ type: 'Raw', xml: e.target.value })} autoFocus />
          </label>
        ) : condition.type === 'OrRule' ? (
          <OrRuleEditor condition={condition} wrapperTag={wrapperTag} onChange={setCondition} />
        ) : (
          <LeafFields condition={condition} onChange={setCondition} />
        )}

        {/* Raw mode already shows/edits the XML directly above -- this is only useful (and only
            shown) for the structured types, as a quick way to see exactly what'll be saved without
            switching "Rule Type" to Raw, which would actually change the editing mode. */}
        {condition.type !== 'Raw' && (
          <>
            <button type="button" className="link-button" onClick={() => setShowXml(v => !v)}>
              {showXml ? 'Hide' : 'View'} raw XML
            </button>
            {showXml && <textarea className="raw-xml" readOnly value={serializeRuleCondition(rule.id, wrapperTag, condition)} />}
          </>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onRemove}>Remove from command</button>
          <div className="dialog-actions-spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

function OrRuleEditor({ condition, wrapperTag, onChange }: {
  condition: Extract<RibbonRuleCondition, { type: 'OrRule' }>;
  wrapperTag: 'EnableRule' | 'DisplayRule';
  onChange: (c: RibbonRuleCondition) => void;
}) {
  const updateAt = (i: number, leaf: RibbonRuleLeafCondition) => {
    const conditions = condition.conditions.slice();
    conditions[i] = leaf;
    onChange({ type: 'OrRule', conditions });
  };
  const removeAt = (i: number) => {
    onChange({ type: 'OrRule', conditions: condition.conditions.filter((_, idx) => idx !== i) });
  };
  const addCondition = () => {
    onChange({ type: 'OrRule', conditions: [...condition.conditions, defaultLeafCondition(leafRuleTypesFor(wrapperTag)[0])] });
  };

  return (
    <div className="or-rule-editor">
      <p className="hint">True if any one of these conditions is true.</p>
      {condition.conditions.map((leaf, i) => (
        <LeafConditionEditor
          // Conditions have no stable id of their own; index is fine here since edits mutate a
          // slot in place rather than reordering the array.
          key={i}
          leaf={leaf}
          wrapperTag={wrapperTag}
          onChange={l => updateAt(i, l)}
          onRemove={() => removeAt(i)}
        />
      ))}
      <button type="button" onClick={addCondition}>+ Add condition</button>
    </div>
  );
}

function LeafConditionEditor({ leaf, wrapperTag, onChange, onRemove }: {
  leaf: RibbonRuleLeafCondition;
  wrapperTag: 'EnableRule' | 'DisplayRule';
  onChange: (leaf: RibbonRuleLeafCondition) => void;
  onRemove: () => void;
}) {
  const availableTypes = leafRuleTypesFor(wrapperTag);
  const typeOptions = availableTypes.includes(leaf.type) ? availableTypes : [leaf.type, ...availableTypes];

  return (
    <div className="or-condition">
      <div className="or-condition-header">
        <select value={leaf.type} onChange={e => onChange(defaultLeafCondition(e.target.value as RibbonRuleLeafConditionType))}>
          {typeOptions.map(t => <option key={t} value={t}>{RULE_CONDITION_LABELS[t]}</option>)}
        </select>
        <button type="button" className="or-condition-remove" onClick={onRemove} aria-label="Remove condition" title="Remove condition">✕</button>
      </div>
      <LeafFields condition={leaf} onChange={onChange} />
    </div>
  );
}

// Ensures the select's current value is always present as an option, even if it falls outside the
// known enum list (legacy/unexpected data) -- otherwise a controlled <select> with no matching
// <option> shows blank, which looks like the field silently lost its value even though it hasn't.
function EnumField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const values = options.includes(value) ? options : [value, ...options];
  return (
    <label>{label}
      <select value={value} onChange={e => onChange(e.target.value)}>
        {values.map(v => <option key={v || '(none)'} value={v}>{v || '(none)'}</option>)}
      </select>
    </label>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label>{label}<input type="text" value={value} onChange={e => onChange(e.target.value)} /></label>;
}

function InvertResult({ condition, onChange }: { condition: RibbonRuleLeafCondition; onChange: (c: RibbonRuleLeafCondition) => void }) {
  return (
    <label className="checkbox-label">
      <input type="checkbox" checked={condition.invertResult} onChange={e => onChange({ ...condition, invertResult: e.target.checked })} />
      Invert result (NOT this condition)
    </label>
  );
}

function LeafFields({ condition, onChange }: { condition: RibbonRuleLeafCondition; onChange: (c: RibbonRuleLeafCondition) => void }) {
  switch (condition.type) {
    case 'CommandClientTypeRule':
      return (
        <>
          <EnumField label="Presentation" value={condition.presentationType} options={COMMAND_CLIENT_TYPES} onChange={v => onChange({ ...condition, presentationType: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'CrmClientTypeRule':
      return (
        <>
          <EnumField label="Client Type" value={condition.clientType} options={CLIENT_TYPES} onChange={v => onChange({ ...condition, clientType: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'CrmOfflineAccessStateRule':
      return (
        <>
          <EnumField label="State" value={condition.state} options={OFFLINE_ACCESS_STATES} onChange={v => onChange({ ...condition, state: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'CrmOutlookClientTypeRule':
      return (
        <>
          <EnumField label="Outlook Client Type" value={condition.outlookClientType} options={OUTLOOK_CLIENT_TYPES} onChange={v => onChange({ ...condition, outlookClientType: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'CustomRule':
      return (
        <>
          <TextField label="Library (web resource name)" value={condition.library} onChange={v => onChange({ ...condition, library: v })} />
          <TextField label="Function name" value={condition.functionName} onChange={v => onChange({ ...condition, functionName: v })} />
          <label>Parameters (comma-separated)
            <input
              type="text"
              value={condition.params.join(', ')}
              onChange={e => onChange({ ...condition, params: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
            />
          </label>
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'EntityRule':
      return (
        <>
          <TextField label="Entity Name (logical name)" value={condition.entityName} onChange={v => onChange({ ...condition, entityName: v })} />
          <EnumField label="Context (optional)" value={condition.context} options={ENTITY_RULE_CONTEXTS} onChange={v => onChange({ ...condition, context: v })} />
          <EnumField label="Applies To (optional)" value={condition.appliesTo} options={APPLIES_TO_OPTIONS} onChange={v => onChange({ ...condition, appliesTo: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'FormStateRule':
      return (
        <>
          <EnumField label="Form State" value={condition.state} options={FORM_STATES} onChange={v => onChange({ ...condition, state: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'OutlookItemTrackingRule':
      return (
        <>
          <label className="checkbox-label">
            <input type="checkbox" checked={condition.trackedInCrm} onChange={e => onChange({ ...condition, trackedInCrm: e.target.checked })} />
            Tracked in CRM
          </label>
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'OutlookVersionRule':
      return (
        <>
          <EnumField label="Outlook Version" value={condition.version} options={OUTLOOK_VERSIONS} onChange={v => onChange({ ...condition, version: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'PageRule':
      return (
        <>
          <TextField label="Page Address (relative path)" value={condition.address} onChange={v => onChange({ ...condition, address: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'RecordPrivilegeRule':
      return (
        <>
          <EnumField label="Privilege Type" value={condition.privilegeType} options={PRIVILEGE_TYPES} onChange={v => onChange({ ...condition, privilegeType: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'SelectionCountRule':
      return (
        <>
          <TextField label="Minimum selected (optional)" value={condition.minimum} onChange={v => onChange({ ...condition, minimum: v })} />
          <TextField label="Maximum selected (optional)" value={condition.maximum} onChange={v => onChange({ ...condition, maximum: v })} />
          <EnumField label="Applies To (optional)" value={condition.appliesTo} options={APPLIES_TO_OPTIONS} onChange={v => onChange({ ...condition, appliesTo: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'SkuRule':
      return (
        <>
          <EnumField label="Dataverse Edition" value={condition.sku} options={SKUS} onChange={v => onChange({ ...condition, sku: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'ValueRule':
      return (
        <>
          <TextField label="Field" value={condition.field} onChange={v => onChange({ ...condition, field: v })} />
          <TextField label="Value" value={condition.value} onChange={v => onChange({ ...condition, value: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'EntityPrivilegeRule':
      return (
        <>
          <TextField label="Entity Name (optional -- required unless Applies To = Primary Entity)" value={condition.entityName} onChange={v => onChange({ ...condition, entityName: v })} />
          <EnumField label="Applies To (optional)" value={condition.appliesTo} options={APPLIES_TO_OPTIONS} onChange={v => onChange({ ...condition, appliesTo: v })} />
          <EnumField label="Privilege Type" value={condition.privilegeType} options={PRIVILEGE_TYPES} onChange={v => onChange({ ...condition, privilegeType: v })} />
          <EnumField label="Privilege Depth" value={condition.privilegeDepth} options={PRIVILEGE_DEPTHS_WITH_NONE} onChange={v => onChange({ ...condition, privilegeDepth: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'EntityPropertyRule':
      return (
        <>
          <TextField label="Entity Name (optional)" value={condition.entityName} onChange={v => onChange({ ...condition, entityName: v })} />
          <EnumField label="Applies To (optional)" value={condition.appliesTo} options={APPLIES_TO_OPTIONS} onChange={v => onChange({ ...condition, appliesTo: v })} />
          <EnumField label="Property Name" value={condition.propertyName} options={ENTITY_PROPERTY_NAMES} onChange={v => onChange({ ...condition, propertyName: v })} />
          <TextField label="Property Value (optional, true/false)" value={condition.propertyValue} onChange={v => onChange({ ...condition, propertyValue: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'FormEntityContextRule':
      return (
        <>
          <TextField label="Entity Name (logical name)" value={condition.entityName} onChange={v => onChange({ ...condition, entityName: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'FormTypeRule':
      return (
        <>
          <EnumField label="Form Type" value={condition.formType} options={FORM_TYPES} onChange={v => onChange({ ...condition, formType: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'HideForTabletExperienceRule':
      return <InvertResult condition={condition} onChange={onChange} />;

    case 'MiscellaneousPrivilegeRule':
      return (
        <>
          <TextField label="Privilege Name (e.g. ExportToExcel, GoOffline -- see Microsoft's privilege reference)" value={condition.privilegeName} onChange={v => onChange({ ...condition, privilegeName: v })} />
          <EnumField label="Privilege Depth (optional)" value={condition.privilegeDepth} options={PRIVILEGE_DEPTHS} onChange={v => onChange({ ...condition, privilegeDepth: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'OrganizationSettingRule':
      return (
        <>
          <EnumField label="Setting" value={condition.setting} options={ORGANIZATION_SETTINGS} onChange={v => onChange({ ...condition, setting: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'OutlookRenderTypeRule':
      return (
        <>
          <EnumField label="Render Type" value={condition.renderType} options={CLIENT_TYPES} onChange={v => onChange({ ...condition, renderType: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );

    case 'ReferencingAttributeRequiredRule':
      return <InvertResult condition={condition} onChange={onChange} />;

    case 'RelationshipTypeRule':
      return (
        <>
          <EnumField label="Relationship Type" value={condition.relationshipType} options={RELATIONSHIP_TYPES} onChange={v => onChange({ ...condition, relationshipType: v })} />
          <InvertResult condition={condition} onChange={onChange} />
        </>
      );
  }
}

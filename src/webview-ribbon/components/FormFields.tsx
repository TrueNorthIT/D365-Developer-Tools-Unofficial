// Small controlled-input field components shared by the ribbon editor's dialogs (RuleDialog,
// ActionDialog) -- factored out once a second dialog needed the exact same patterns.

// Ensures the select's current value is always present as an option, even if it falls outside the
// known enum list (legacy/unexpected data) -- otherwise a controlled <select> with no matching
// <option> shows blank, which looks like the field silently lost its value even though it hasn't.
export function EnumField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const values = options.includes(value) ? options : [value, ...options];
  return (
    <label>{label}
      <select value={value} onChange={e => onChange(e.target.value)}>
        {values.map(v => <option key={v || '(none)'} value={v}>{v || '(none)'}</option>)}
      </select>
    </label>
  );
}

export function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label>{label}<input type="text" value={value} onChange={e => onChange(e.target.value)} /></label>;
}

export function CheckboxField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="checkbox-label">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

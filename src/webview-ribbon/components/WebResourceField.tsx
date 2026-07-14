import { useEffect, useRef, useState } from 'react';
import { useWebResourceSearch } from '../queries';

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

// A plain text field backed by a live web resource name search -- used anywhere a ribbon control
// currently references a web resource by name (icons, JS libraries), so you don't have to already
// know the exact name to type. Suggestions are just that: the field stays a free-text input (some
// of these also accept a system path or a built-in Fluent icon name, not only a web resource), and
// picking one only ever fills in the text, it never restricts what you can type.
export function WebResourceField({ label, value, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const results = useWebResourceSearch(value);

  useEffect(() => {
    const onOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('click', onOutsideClick);
    return () => document.removeEventListener('click', onOutsideClick);
  }, []);

  const suggestions = results.data ?? [];
  const showSuggestions = open && value.trim().length > 0 && suggestions.length > 0;

  return (
    <label>
      {label}
      <div className="web-resource-field" ref={containerRef}>
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={e => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); } }}
        />
        {showSuggestions && (
          <ul className="web-resource-suggestions">
            {suggestions.map(name => (
              <li key={name}>
                <button type="button" onClick={() => { onChange(name); setOpen(false); }}>{name}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </label>
  );
}

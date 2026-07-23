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

  // The field's own value carries the real `$webresource:` reference once a suggestion has been
  // picked (see the button's onClick below) -- but Dataverse web resource names never include that
  // prefix themselves, so searching on the raw value would stop matching anything the moment it's
  // there. Strip it just for the search query; the field itself keeps showing the full reference.
  const searchQuery = value.startsWith('$webresource:') ? value.slice('$webresource:'.length) : value;
  const results = useWebResourceSearch(searchQuery);

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
  const showSuggestions = open && searchQuery.trim().length > 0 && suggestions.length > 0;

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
                {/* A search result is always a real web resource name, so it's stored with the
                    explicit `$webresource:` reference Dataverse actually resolves -- see
                    webResourceRef in ribbonXmlBuilder.ts, which used to only add this at export
                    time; doing it here too means the field reflects the real value immediately. */}
                <button type="button" onClick={() => { onChange(`$webresource:${name}`); setOpen(false); }}>{name}</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </label>
  );
}

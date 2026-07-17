import { useEffect, useRef, useState } from 'react';
import { buildRibbonElementId, firstUnusedName, kindSuffixFor, type PromptRequest } from '../ribbonState';

interface Props {
  title: string;
  request: PromptRequest;
  publisherPrefix: string;
  entityLogicalName: string;
  /** Every id already in the model -- used to preview the id live and flag a collision before
   *  submitting (App.tsx recomputes this on every render via collectAllIds, cheap enough for a modal). */
  existingIds: Set<string>;
  /** Pre-filled starting value for the Name field -- e.g. a command defaults to its control's name,
   *  a rule to its command's (see App.tsx, which derives this via extractNameSegment). Already
   *  de-duplicated by the caller; empty/undefined when there's no sensible default (tabs, groups,
   *  and controls have nothing to inherit a name from). Purely a starting value -- the user can still
   *  freely edit it, and doing so behaves exactly like typing into a blank field. */
  initialName?: string;
  onSubmit: (name: string, menuSectionName?: string) => void;
  onClose: () => void;
}

// A small modal for naming a new tab/group/control/command/rule before it's actually created --
// added because ids are now built as {publisherPrefix}.{entityLogicalName}.{name}.{kind} (see
// buildRibbonElementId in ribbonState.ts) instead of an internal throwaway counter, so creating
// anything now needs a real name up front. Follows the same .dialog-backdrop/.dialog structure as
// ParametersDialog/RuleDialog for visual consistency, though it's simple enough not to share code
// with either (just one field, no per-item list).
//
// Everything id-related (the live preview, validation, and the FlyoutAnchor menu section default
// below) is computed here from `name`/`menuSectionName` state on every render, rather than passed in
// as a precomputed prop from App.tsx -- a prop computed once at open time can't reflect what's
// actually been typed since, which is exactly why the preview used to look frozen.
export function NamePromptDialog({ title, request, publisherPrefix, entityLogicalName, existingIds, initialName, onSubmit, onClose }: Props) {
  const [name, setName] = useState(initialName ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  const isButtonLikeControl = request.kind === 'control' && (request.controlKind === 'Button' || request.controlKind === 'SplitButton');
  const hasMenuSection = request.kind === 'control' && request.controlKind === 'FlyoutAnchor';
  const [menuSectionName, setMenuSectionName] = useState('');
  const [menuSectionTouched, setMenuSectionTouched] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select(); // easy to overtype a pre-filled default (see initialName) in one go
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keeps the menu section name matching the flyout's own name (de-duplicated) until the user edits
  // it themselves -- once touched, typing in the Name field above no longer overwrites their choice.
  useEffect(() => {
    if (!hasMenuSection || menuSectionTouched) { return; }
    setMenuSectionName(publisherPrefix ? firstUnusedName(name, candidate => existingIds.has(buildRibbonElementId(publisherPrefix, entityLogicalName, candidate, 'menusection'))) : name);
  }, [name, hasMenuSection, menuSectionTouched, publisherPrefix, entityLogicalName, existingIds]);

  const previewId = (fieldName: string, kindSuffix: string): string | undefined =>
    publisherPrefix ? buildRibbonElementId(publisherPrefix, entityLogicalName, fieldName || '…', kindSuffix) : undefined;

  const fieldError = (fieldName: string, kindSuffix: string): string | undefined => {
    if (!publisherPrefix) { return 'A publisher prefix is required -- set "d365.ribbonEditor.publisherPrefix" and reopen the ribbon editor.'; }
    if (!fieldName.trim()) { return undefined; }
    const id = buildRibbonElementId(publisherPrefix, entityLogicalName, fieldName, kindSuffix);
    return existingIds.has(id) ? `"${id}" already exists in this ribbon -- pick a different name.` : undefined;
  };

  const mainKindSuffix = kindSuffixFor(request);
  const mainError = fieldError(name, mainKindSuffix);
  const menuSectionError = hasMenuSection ? fieldError(menuSectionName, 'menusection') : undefined;

  const canSubmit = name.trim().length > 0 && !mainError && (!hasMenuSection || (menuSectionName.trim().length > 0 && !menuSectionError));
  const submit = (): void => {
    if (!canSubmit) { return; }
    onSubmit(name.trim(), hasMenuSection ? menuSectionName.trim() : undefined);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{title}</h3>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close" title="Close">✕</button>
        </div>

        <label>Name
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { submit(); } }}
          />
        </label>
        <p className="hint">Id will be "{previewId(name, mainKindSuffix) ?? mainKindSuffix}".</p>
        {isButtonLikeControl && <p className="hint">A command will be created automatically with this same name.</p>}
        {mainError && <p className="hint dialog-error">{mainError}</p>}

        {hasMenuSection && (
          <>
            <label>Menu Section Name
              <input
                type="text"
                value={menuSectionName}
                onChange={e => { setMenuSectionTouched(true); setMenuSectionName(e.target.value); }}
                onKeyDown={e => { if (e.key === 'Enter') { submit(); } }}
              />
            </label>
            <p className="hint">Defaults to match the flyout's name (de-duplicated); id will be "{previewId(menuSectionName, 'menusection') ?? 'menusection'}".</p>
            {menuSectionError && <p className="hint dialog-error">{menuSectionError}</p>}
          </>
        )}

        <div className="dialog-actions">
          <div className="dialog-actions-spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary" disabled={!canSubmit} onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  );
}

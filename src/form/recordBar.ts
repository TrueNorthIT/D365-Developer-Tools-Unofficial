import { escapeHtml, ICON } from './formRenderer';
import { isGuid, LookupResult, NO_NAME, requireGuid } from './recordPreview';

/**
 * Pure rendering and message validation for the form previewer's "Record" lookup (the live record selector above the
 * form). No `vscode` import, no script, everything escaped. The webview script in FormPreviewPanel drives it; the
 * extension builds every query, so the webview only ever sends the messages `parseWebviewMessage` accepts.
 */

export interface RecordBarState {
    /** Signed in to Dynamics; when false the lookup is disabled. */
    connected: boolean;
    /** Environment URL the records come from (shown so it's clear when the preview reads from prod). */
    environment?: string;
    /** Table display name, for the "Look for …" placeholder. */
    entityName: string;
    selected?: { id: string; name: string };
}

export type LookupListState =
    | { kind: 'recent'; items: LookupResult[] }
    | { kind: 'searching' }
    | { kind: 'results'; items: LookupResult[] }
    | { kind: 'error'; message: string };

/** Messages the webview may send. Anything else (including any FetchXML) is ignored. */
export type WebviewMessage =
    | { type: 'ready' }
    /** `submit`: Enter or the search button — searches even when blank, instead of listing recent records. */
    | { type: 'search'; text: string; submit?: true }
    | { type: 'select'; id: string }
    | { type: 'clear' };

/** Longest search text accepted from the webview. */
export const MAX_SEARCH_LENGTH = 200;

export const SIGNED_OUT_TEXT = 'Sign in to Dynamics to preview a record';

export function renderRecordBar(state: RecordBarState): string {
    let control: string;
    let caption: string;
    if (!state.connected) {
        control = `<div class="input k-lookup rec-lookup disabled">`
            + `<input class="rec-input" type="text" disabled placeholder="${escapeHtml(SIGNED_OUT_TEXT)}" aria-label="${escapeHtml(SIGNED_OUT_TEXT)}">`
            + `${ICON.search}</div>`;
        caption = '';
    } else if (state.selected) {
        const name = state.selected.name || NO_NAME;
        control = `<div class="input k-lookup rec-lookup has-chip" data-selected="${escapeHtml(state.selected.id)}">`
            + `<span class="rec-chip"><span class="rec-chip-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`
            + '<button type="button" class="rec-clear" data-action="clear" title="Clear" aria-label="Clear the selected record">✕</button></span>'
            + `${ICON.search}</div>`;
        caption = state.environment ? `Record from ${state.environment}` : '';
    } else {
        const placeholder = `Look for ${state.entityName}`;
        control = `<div class="input k-lookup rec-lookup">`
            + `<input class="rec-input" type="text" autocomplete="off" spellcheck="false" maxlength="${MAX_SEARCH_LENGTH}"`
            + ` placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}" role="combobox" aria-expanded="false">`
            + `<button type="button" class="rec-search" data-action="search" title="Search" aria-label="Search records">${ICON.search}</button></div>`;
        caption = state.environment ? `Records from ${state.environment}` : '';
    }
    return '<div class="d365-form rec-bar-host"><div class="rec-bar">'
        + '<div class="field rec-field"><div class="label"><span class="label-text">Record</span></div>'
        + control
        + '<div class="rec-results" role="listbox" hidden></div></div>'
        + (caption ? `<div class="rec-caption">${escapeHtml(caption)}</div>` : '')
        + '</div></div>';
}

function renderItem(item: LookupResult): string {
    return `<div class="rec-item" role="option" data-id="${escapeHtml(item.id)}">`
        + `<div class="rec-primary">${escapeHtml(item.primary || NO_NAME)}</div>`
        + item.secondary.map(s => `<div class="rec-secondary">${escapeHtml(s)}</div>`).join('')
        + '</div>';
}

export function renderLookupResults(state: LookupListState): string {
    switch (state.kind) {
        case 'searching':
            return '<div class="rec-msg">Searching…</div>';
        case 'error':
            return `<div class="rec-msg error">${escapeHtml(state.message)}</div>`;
        case 'recent':
            return state.items.length
                ? '<div class="rec-head">Recent records</div>' + state.items.map(renderItem).join('')
                : '<div class="rec-msg">No recent records. Type to search.</div>';
        case 'results':
            return state.items.length
                ? state.items.map(renderItem).join('')
                : '<div class="rec-msg">No records found</div>';
    }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a message from the webview; returns only the fields the extension uses, or undefined when it doesn't fit. */
export function parseWebviewMessage(msg: unknown): WebviewMessage | undefined {
    if (!isObj(msg)) { return undefined; }
    switch (msg.type) {
        case 'ready':
            return { type: 'ready' };
        case 'clear':
            return { type: 'clear' };
        case 'search':
            if (typeof msg.text !== 'string' || msg.text.length > MAX_SEARCH_LENGTH) { return undefined; }
            return msg.submit === true ? { type: 'search', text: msg.text, submit: true } : { type: 'search', text: msg.text };
        case 'select':
            return isGuid(msg.id) ? { type: 'select', id: requireGuid(msg.id) } : undefined;
        default:
            return undefined;
    }
}

/** Lookup styling on top of FORM_CSS (`.input.k-lookup`, `.field`, `.label`). */
export const RECORD_BAR_CSS = `
.d365-form.rec-bar-host{min-height:0;padding:8px 8px 0}
.d365-form .rec-bar{background:#fff;border-radius:8px;padding:0 20px 10px;box-shadow:rgba(0,0,0,.12) 0 0 2px,rgba(0,0,0,.14) 0 2px 4px}
.d365-form .rec-field{position:relative}
.d365-form .rec-input{all:unset;flex:1 1 auto;min-width:0;color:var(--fg1);font:inherit;line-height:20px}
.d365-form .rec-input::placeholder{color:var(--fg3)}
.d365-form .rec-lookup.disabled{background:transparent;padding-left:0}
.d365-form .rec-lookup.disabled:hover{border-bottom-color:transparent}
.d365-form .rec-lookup.disabled .rec-input::placeholder{font-style:italic}
.d365-form .rec-chip{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;background:#ebf3fc;border-radius:4px;padding:0 2px 0 8px;line-height:22px}
.d365-form .rec-chip-name{color:#115ea3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.d365-form .rec-clear{all:unset;cursor:pointer;padding:0 6px;border-radius:2px;color:var(--fg2);font-size:12px}
.d365-form .rec-clear:hover,.d365-form .rec-clear:focus-visible{background:#cfe4fa}
.d365-form .rec-search{all:unset;display:inline-flex;cursor:pointer;padding:4px;margin:-4px -4px -4px 0;border-radius:4px}
.d365-form .rec-search:hover,.d365-form .rec-search:focus-visible{background:#e0e0e0}
.d365-form .rec-results{position:absolute;z-index:10;left:184px;right:2px;top:calc(100% - 2px);background:#fff;border-radius:4px;
  box-shadow:rgba(0,0,0,.12) 0 0 2px,rgba(0,0,0,.14) 0 8px 16px;max-height:360px;overflow:auto;padding:4px 0}
.d365-form .rec-results[hidden]{display:none}
.d365-form .rec-head{font-size:12px;line-height:16px;color:var(--fg3);padding:4px 12px}
.d365-form .rec-item{padding:6px 12px;cursor:pointer}
.d365-form .rec-item:hover,.d365-form .rec-item.active{background:#f5f5f5}
.d365-form .rec-primary{color:var(--fg1)}
.d365-form .rec-secondary{font-size:12px;line-height:16px;color:var(--fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.d365-form .rec-msg{padding:8px 12px;color:var(--fg3);font-style:italic}
.d365-form .rec-msg.error{color:var(--req);font-style:normal;white-space:pre-wrap}
.d365-form .rec-caption{font-size:12px;line-height:16px;color:var(--fg3);padding:4px 0 0 184px;overflow-wrap:anywhere}
`;

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseFormYaml, parseTableYaml, TableModel } from './form/formModel';
import { renderErrorHtml, renderFormHtml } from './form/formRenderer';
import { FORM_CSS } from './form/formStyles';
import {
    LookupListState, MAX_SEARCH_LENGTH, parseWebviewMessage, RECORD_BAR_CSS, renderLookupResults, renderRecordBar,
} from './form/recordBar';
import type { LookupResult } from './form/recordPreview';
import { SiblingTableLoader } from './form/viewLoader';
import { ConnectionManager } from './connectionManager';
import { DataverseClient } from './dataverseClient';
import { FormRecordSource, RecordRemote } from './formRecordSource';
import { FormSubgridSource, RemoteMetadata } from './formSubgridSource';
import { dataverseErrorMessage } from './view/viewQuery';

const REFRESH_DEBOUNCE_MS = 250;
/** The webview waits this long after the last keystroke before asking for a search. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Live preview of a d365architect `*.form.yml`. Renders offline from the YAML plus the
 * sibling `*.table.yml` (for display names, attribute types and required levels).
 * Re-renders as the document is edited; does not need a Dataverse connection.
 *
 * Subgrid views are looked up in the export on disk first, then fetched from Dynamics if signed in
 * (re-rendering when they arrive), and otherwise left blank.
 *
 * When signed in, the "Record" lookup above the form picks a live record: the form then shows its values, subgrids its
 * related rows and quick views its related record (FormRecordSource). Read-only. The webview only sends search text, a
 * picked id or "clear"; every query is built here. The selection lives in the extension, so it survives the webview
 * reloading (e.g. when moved to a new window), and is forgotten when the panel closes or the connection changes.
 */
export class FormPreviewPanel {
    private static readonly panels = new Map<string, FormPreviewPanel>();

    private readonly disposables: vscode.Disposable[] = [];
    private refreshTimer: NodeJS.Timeout | undefined;
    private readonly subgrids: FormSubgridSource;
    private readonly records: FormRecordSource;
    /** Records currently listed in the lookup, by id: only these can be selected. */
    private offered = new Map<string, LookupResult>();
    /** Bumped on every search, selection and connection change; a search response is only shown if it still matches. */
    private searchSeq = 0;
    /** Entity and display name of the form as last rendered, for the lookup. */
    private entity = '';
    private entityName = '';
    private disposed = false;

    /** Opens (or reveals) the preview beside the editor, or in its own floating window when `newWindow` is set. */
    static show(uri: vscode.Uri, connectionManager: ConnectionManager, client: DataverseClient, newWindow = false): void {
        const key = uri.toString();
        const existing = FormPreviewPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal(newWindow ? undefined : vscode.ViewColumn.Beside, !newWindow);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'd365.formPreview',
                `Preview: ${path.basename(uri.fsPath)}`,
                { viewColumn: newWindow ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside, preserveFocus: !newWindow },
                { enableScripts: true, retainContextWhenHidden: true },
            );
            FormPreviewPanel.panels.set(key, new FormPreviewPanel(panel, uri, connectionManager, client));
        }
        // Moves the active editor (the preview, focused above) into a new window.
        if (newWindow) { void vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); }
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly uri: vscode.Uri,
        private readonly connectionManager: ConnectionManager,
        client: DataverseClient,
    ) {
        // Forms live in <root>/<entity>/, so sibling entities (subgrid targets, quick view forms) are under the parent folder.
        const loader = new SiblingTableLoader(path.dirname(path.dirname(uri.fsPath)));
        this.subgrids = new FormSubgridSource(loader, remoteMetadata(connectionManager, client), () => this.scheduleRefresh());
        this.records = new FormRecordSource(
            {
                loadViews: entity => loader.loadViews(entity),
                loadForms: entity => loader.loadForms(entity),
                loadTable: entity => this.subgrids.loadTable(entity),
            },
            recordRemote(connectionManager, client),
            () => this.scheduleRefresh(),
        );
        const body = this.renderBody();
        panel.webview.html = this.buildShell(this.renderBar(), body);
        this.disposables.push(
            panel.onDidDispose(() => this.dispose()),
            panel.webview.onDidReceiveMessage(msg => this.onMessage(msg)),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === uri.toString()) { this.scheduleRefresh(); }
            }),
            // Table and view files drive labels/types/subgrid columns, so refresh when one is saved.
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (/\.(table|view|form)\.yml$/.test(doc.uri.fsPath)) { this.scheduleRefresh(); }
            }),
            // Signing in, out or switching environment: retry anything that failed, and forget the picked record.
            connectionManager.onDidChangeConnection(() => {
                this.subgrids.reset();
                this.records.reset();
                this.offered = new Map();
                this.searchSeq++;
                this.postBar();
                this.scheduleRefresh();
            }),
        );
    }

    private onMessage(raw: unknown): void {
        const msg = parseWebviewMessage(raw);
        if (!msg || this.disposed) { return; }
        switch (msg.type) {
            case 'ready':
                // The webview reloads its initial HTML when moved to another window, so redraw whenever it (re)loads.
                this.postBar();
                this.postRender();
                return;
            case 'search':
                this.search(msg.text, msg.submit === true);
                return;
            case 'select': {
                const item = this.offered.get(msg.id);
                if (!item || !this.entity || !this.connectionManager.isConnected) { return; }
                this.searchSeq++;
                this.records.select(this.entity, item);
                this.postBar();
                this.postRender();
                return;
            }
            case 'clear':
                this.searchSeq++;
                this.records.clear();
                this.postBar();
                this.postRender();
                return;
        }
    }

    /**
     * Blank text lists this session's recent records for the table, unless submitted (Enter / search button), which
     * lists the table's records through its Quick Find view unfiltered by text; anything else searches that view.
     */
    private search(text: string, submit = false): void {
        const seq = ++this.searchSeq;
        if (!this.connectionManager.isConnected || !this.entity) { return; }
        const show = (state: LookupListState, items: LookupResult[] = []) => {
            if (seq !== this.searchSeq || this.disposed) { return; }
            this.offered = new Map(items.map(i => [i.id, i]));
            void this.panel.webview.postMessage({ type: 'results', html: renderLookupResults(state) });
        };
        if (!text.trim() && !submit) {
            const items = this.records.recents(this.entity);
            show({ kind: 'recent', items }, items);
            return;
        }
        show({ kind: 'searching' });
        this.records.search(this.entity, text).then(
            items => show({ kind: 'results', items }, items),
            err => show({ kind: 'error', message: dataverseErrorMessage(err instanceof Error ? err.message : String(err)) }),
        );
    }

    private scheduleRefresh(): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.postRender(), REFRESH_DEBOUNCE_MS);
    }

    private postRender(): void {
        if (this.disposed) { return; }
        void this.panel.webview.postMessage({ type: 'render', html: this.renderBody() });
    }

    private postBar(): void {
        if (this.disposed) { return; }
        void this.panel.webview.postMessage({ type: 'bar', html: this.renderBar() });
    }

    private renderBar(): string {
        const selected = this.records.selected;
        return renderRecordBar({
            connected: this.connectionManager.isConnected,
            environment: this.connectionManager.connection?.environmentUrl,
            entityName: this.entityName || this.entity || 'records',
            selected: selected && { id: selected.id, name: selected.name },
        });
    }

    private renderBody(): string {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === this.uri.toString());
        let text: string;
        try {
            text = doc ? doc.getText() : fs.readFileSync(this.uri.fsPath, 'utf8');
        } catch (err) {
            return renderErrorHtml([`Could not read ${this.uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`]);
        }
        const parsed = parseFormYaml(text);
        if (!parsed.model) { return renderErrorHtml(parsed.errors); }

        const warnings = [...parsed.errors];
        const table = this.loadTable(parsed.model.entity, warnings);
        this.entity = parsed.model.entity;
        this.entityName = table?.displayName ?? parsed.model.entity;
        const { record, notices } = this.records.view(parsed.model, table);
        return renderFormHtml(parsed.model, table, [...warnings, ...notices], this.subgrids, record);
    }

    /** Looks for `<entity>.table.yml` in the form's folder, then any `*.table.yml` whose entity matches. */
    private loadTable(entity: string, warnings: string[]): TableModel | undefined {
        const dir = path.dirname(this.uri.fsPath);
        try {
            const candidates = [`${entity}.table.yml`, ...fs.readdirSync(dir).filter(f => f.endsWith('.table.yml'))];
            for (const file of new Set(candidates)) {
                const full = path.join(dir, file);
                if (!fs.existsSync(full)) { continue; }
                const parsed = parseTableYaml(fs.readFileSync(full, 'utf8'));
                if (parsed.model && (!entity || parsed.model.entity === entity)) { return parsed.model; }
            }
        } catch (err) {
            warnings.push(`Could not read table file: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
        warnings.push(`No ${entity || '*'}.table.yml found next to the form — showing field names and generic widgets.`);
        return undefined;
    }

    private buildShell(barHtml: string, bodyHtml: string): string {
        const nonce = makeNonce();
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;background:#fafafa}${FORM_CSS}${RECORD_BAR_CSS}</style></head>
<body><div id="bar">${barHtml}</div><div id="root">${bodyHtml}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const bar = document.getElementById('bar');
let activeTab = 0;
function applyTab() {
  const btns = root.querySelectorAll('[data-tab]');
  if (!btns.length) { return; }
  if (activeTab >= btns.length) { activeTab = 0; }
  btns.forEach(b => b.classList.toggle('active', Number(b.dataset.tab) === activeTab));
  root.querySelectorAll('[data-tab-panel]').forEach(p => p.classList.toggle('active', Number(p.dataset.tabPanel) === activeTab));
}
root.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('[data-tab]');
  if (btn) { activeTab = Number(btn.dataset.tab); applyTab(); }
});

// Record lookup: sends only search text, a listed record's id, or "clear". The extension builds every query.
let searchTimer;
let activeItem = -1;
const inputEl = () => bar.querySelector('.rec-input');
const resultsEl = () => bar.querySelector('.rec-results');
function search(text, submit) {
  clearTimeout(searchTimer);
  const msg = { type: 'search', text: String(text).slice(0, ${MAX_SEARCH_LENGTH}) };
  if (submit) { msg.submit = true; }
  vscode.postMessage(msg);
}
function showResults(html) {
  const input = inputEl(), list = resultsEl();
  if (!input || !list || input.disabled || document.activeElement !== input) { return; }
  list.innerHTML = html;
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  activeItem = -1;
}
function hideResults() {
  const input = inputEl(), list = resultsEl();
  if (list) { list.hidden = true; }
  if (input) { input.setAttribute('aria-expanded', 'false'); }
}
function select(item) {
  hideResults();
  vscode.postMessage({ type: 'select', id: item.dataset.id });
}
bar.addEventListener('input', e => {
  if (e.target !== inputEl()) { return; }
  const text = e.target.value;
  clearTimeout(searchTimer);
  if (!text.trim()) { search(''); return; }
  searchTimer = setTimeout(() => search(text), ${SEARCH_DEBOUNCE_MS});
});
let focusedAt = 0;
bar.addEventListener('focusin', e => {
  if (e.target === inputEl()) {
    focusedAt = Date.now();
    if (!e.target.value.trim()) { search(''); }
  }
});
bar.addEventListener('click', e => {
  const target = e.target.closest ? e.target : e.target.parentElement;
  const item = target.closest('.rec-item');
  if (item) { select(item); return; }
  if (target.closest('[data-action="clear"]')) { vscode.postMessage({ type: 'clear' }); return; }
  const input = inputEl();
  if (input && !input.disabled && target.closest('[data-action="search"]')) {
    // Results only show while the box has focus, so focus first (its focusin recents request is superseded).
    input.focus();
    search(input.value, true);
    return;
  }
  if (input && !input.disabled && target.closest('.rec-lookup')) {
    if (document.activeElement === input) {
      // Re-open the recent list on a click into an already-focused, empty lookup (focusing it has just done so otherwise).
      if (Date.now() - focusedAt > 500 && resultsEl().hidden && !input.value.trim()) { search(''); }
    } else {
      input.focus();
    }
  }
});
bar.addEventListener('keydown', e => {
  const list = resultsEl();
  if (!list) { return; }
  if (e.key === 'Escape') { hideResults(); return; }
  const items = Array.from(list.querySelectorAll('.rec-item'));
  // Enter with nothing highlighted searches now (blank lists the table's records) rather than waiting for the pause.
  const input = inputEl();
  if (e.key === 'Enter' && e.target === input && (list.hidden || activeItem < 0)) {
    e.preventDefault();
    search(input.value, true);
    return;
  }
  if (list.hidden || !items.length) { return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeItem = (activeItem + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((it, i) => it.classList.toggle('active', i === activeItem));
    items[activeItem].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && activeItem >= 0) {
    e.preventDefault();
    select(items[activeItem]);
  }
});
document.addEventListener('mousedown', e => { if (!bar.contains(e.target)) { hideResults(); } });

window.addEventListener('message', e => {
  const msg = e.data;
  if (!msg) { return; }
  if (msg.type === 'render') { root.innerHTML = msg.html; applyTab(); }
  else if (msg.type === 'bar') { bar.innerHTML = msg.html; }
  else if (msg.type === 'results') { showResults(msg.html); }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
    }

    private dispose(): void {
        this.disposed = true;
        clearTimeout(this.refreshTimer);
        this.subgrids.dispose();
        this.records.dispose();
        FormPreviewPanel.panels.delete(this.uri.toString());
        this.disposables.forEach(d => d.dispose());
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) { out += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return out;
}

/** Adapts the extension's Dataverse client to the narrow interface the subgrid source needs. */
function remoteMetadata(connectionManager: ConnectionManager, client: DataverseClient): RemoteMetadata {
    return {
        isConnected: () => connectionManager.isConnected,
        getSavedQuery: id => client.getSavedQuery(id),
        getAttributes: entity => client.getAttributes(entity),
        getEntityDisplayName: entity => client.getEntityDisplayName(entity),
    };
}

/** Adapts the Dataverse client to the (read-only) interface the record selector needs. */
function recordRemote(connectionManager: ConnectionManager, client: DataverseClient): RecordRemote {
    return {
        environment: () => (connectionManager.isConnected ? connectionManager.connection?.environmentUrl : undefined),
        getPrimaryAttributes: entity => client.getPrimaryAttributes(entity),
        getAttributes: entity => client.getAttributes(entity),
        getRelationship: schemaName => client.getRelationship(schemaName),
        getViewByQueryType: (entity, queryType) => client.getViewByQueryType(entity, queryType),
        executeFetchXml: (entity, fetchXml, maxRows) => client.executeFetchXml(entity, fetchXml, maxRows),
    };
}

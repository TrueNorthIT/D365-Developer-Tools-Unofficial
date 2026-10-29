import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { applyGlobalChoices, parseTableYaml, parseViewYaml, TableModel, ViewModel } from './form/formModel';
import { renderErrorHtml } from './form/formRenderer';
import { FORM_CSS } from './form/formStyles';
import { SiblingTableLoader } from './form/viewLoader';
import { ConnectionManager } from './connectionManager';
import { DataverseClient } from './dataverseClient';
import { LabelResolver, dataverseErrorMessage } from './view/viewQuery';
import { renderViewHtml, RowsState, VIEW_CSS } from './view/viewRenderer';

const REFRESH_DEBOUNCE_MS = 250;
/** Live rows wait for a longer pause than the re-render, so a burst of typing costs one query, not several. */
const FETCH_DEBOUNCE_MS = 800;
const MAX_ROWS = 50;

/**
 * Live preview of a d365architect `*.view.yml`: the view's details (table, type, sort, filter) and its grid, labelled
 * from the sibling `*.table.yml` files and `choices.yml`. Re-renders as the document is edited.
 *
 * When signed in, the FetchXML is run against the connected environment and the first rows are shown. Queries run only
 * once typing pauses and the FetchXML (or connection) has actually changed; a slow earlier query never overwrites a newer one.
 */
export class ViewPreviewPanel {
    private static readonly panels = new Map<string, ViewPreviewPanel>();

    private readonly disposables: vscode.Disposable[] = [];
    private readonly loader: SiblingTableLoader;
    private refreshTimer: NodeJS.Timeout | undefined;
    private fetchTimer: NodeJS.Timeout | undefined;
    private rows: RowsState = { kind: 'signed-out' };
    /** Environment + entity + FetchXML of the rows currently shown (or being fetched); a fetch is skipped when unchanged. */
    private rowsKey: string | undefined;
    /** Bumped on every fetch and connection change; a response is only used if it still matches. */
    private fetchSeq = 0;
    private disposed = false;

    /** Opens (or reveals) the preview beside the editor, or in its own floating window when `newWindow` is set. */
    static show(uri: vscode.Uri, connectionManager: ConnectionManager, client: DataverseClient, newWindow = false): void {
        const key = uri.toString();
        const existing = ViewPreviewPanel.panels.get(key);
        if (existing) {
            existing.panel.reveal(newWindow ? undefined : vscode.ViewColumn.Beside, !newWindow);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'd365.viewPreview',
                `Preview: ${path.basename(uri.fsPath)}`,
                { viewColumn: newWindow ? vscode.ViewColumn.Active : vscode.ViewColumn.Beside, preserveFocus: !newWindow },
                { enableScripts: true, retainContextWhenHidden: true },
            );
            ViewPreviewPanel.panels.set(key, new ViewPreviewPanel(panel, uri, connectionManager, client));
        }
        // Moves the active editor (the preview, focused above) into a new window.
        if (newWindow) { void vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); }
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly uri: vscode.Uri,
        private readonly connectionManager: ConnectionManager,
        private readonly client: DataverseClient,
    ) {
        // Views live in <root>/<entity>/, so linked tables and choices.yml are found from the parent folder.
        this.loader = new SiblingTableLoader(path.dirname(path.dirname(uri.fsPath)));
        // First load: start the query straight away (no typing to wait for), so the first render already says "Loading".
        this.fetchRowsIfChanged();
        panel.webview.html = this.buildShell(this.renderBody());
        this.disposables.push(
            panel.onDidDispose(() => this.dispose()),
            // The webview reloads its initial HTML when moved to another window, so redraw whenever it (re)loads.
            panel.webview.onDidReceiveMessage(msg => {
                if (msg && msg.type === 'ready') { this.postRender(); }
            }),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.document.uri.toString() === uri.toString()) {
                    this.scheduleRefresh();
                    this.scheduleFetch();
                }
            }),
            // Table files and choices.yml drive the labels, so refresh when one is saved.
            vscode.workspace.onDidSaveTextDocument(doc => {
                if (/\.table\.yml$|(^|[\\/])choices\.yml$/.test(doc.uri.fsPath)) { this.scheduleRefresh(); }
            }),
            // Signing in, out or switching environment: drop the old rows and query the new connection.
            connectionManager.onDidChangeConnection(() => {
                this.fetchSeq++;
                this.rowsKey = undefined;
                this.fetchRowsIfChanged();
                this.scheduleRefresh();
            }),
        );
    }

    private scheduleRefresh(): void {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.postRender(), REFRESH_DEBOUNCE_MS);
    }

    private scheduleFetch(): void {
        clearTimeout(this.fetchTimer);
        this.fetchTimer = setTimeout(() => this.fetchRowsIfChanged(), FETCH_DEBOUNCE_MS);
    }

    private postRender(): void {
        if (this.disposed) { return; }
        void this.panel.webview.postMessage({ type: 'render', html: this.renderBody() });
    }

    /** Reads the view as currently edited (unsaved text included). */
    private readView(): { view?: ViewModel; errors: string[] } {
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === this.uri.toString());
        let text: string;
        try {
            text = doc ? doc.getText() : fs.readFileSync(this.uri.fsPath, 'utf8');
        } catch (err) {
            return { errors: [`Could not read ${this.uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`] };
        }
        const parsed = parseViewYaml(text);
        return { view: parsed.model, errors: parsed.errors };
    }

    private renderBody(): string {
        const { view, errors } = this.readView();
        if (!view) { return renderErrorHtml(errors); }
        const warnings = [...errors];
        if (!view.entity) { warnings.push('Missing `entity` — rows can\'t be loaded and labels are logical names.'); }
        return renderViewHtml({ view, labels: this.labels(view.entity, warnings), rows: this.rows, warnings, maxRows: MAX_ROWS });
    }

    /** Labels from the view's own table file and linked tables' files, with global choice labels from choices.yml merged in. */
    private labels(entity: string, warnings: string[]): LabelResolver {
        const choices = this.loader.loadChoices();
        const table = entity ? this.loadTable(entity, warnings) : undefined;
        return {
            table: table && applyGlobalChoices(table, choices),
            linkedTable: linked => {
                const t = this.loader.loadTable(linked);
                return t && applyGlobalChoices(t, choices);
            },
        };
    }

    /** `<entity>.table.yml` in the view's folder (via the cached loader), then any `*.table.yml` there whose entity matches. */
    private loadTable(entity: string, warnings: string[]): TableModel | undefined {
        const dir = path.dirname(this.uri.fsPath);
        if (path.basename(dir) === entity) {
            const cached = this.loader.loadTable(entity);
            if (cached) { return cached; }
        }
        try {
            const candidates = [`${entity}.table.yml`, ...fs.readdirSync(dir).filter(f => f.endsWith('.table.yml'))];
            for (const file of new Set(candidates)) {
                const full = path.join(dir, file);
                if (!fs.existsSync(full)) { continue; }
                const parsed = parseTableYaml(fs.readFileSync(full, 'utf8'));
                if (parsed.model && parsed.model.entity === entity) { return parsed.model; }
            }
        } catch (err) {
            warnings.push(`Could not read table file: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
        warnings.push(`No ${entity}.table.yml found next to the view — showing logical names.`);
        return undefined;
    }

    /** Runs the view's FetchXML when signed in and it differs from what the grid already shows. */
    private fetchRowsIfChanged(): void {
        if (this.disposed) { return; }
        const connection = this.connectionManager.connection;
        if (!this.connectionManager.isConnected || !connection) {
            if (this.rows.kind !== 'signed-out') { this.rows = { kind: 'signed-out' }; this.scheduleRefresh(); }
            this.rowsKey = undefined;
            return;
        }
        const { view } = this.readView();
        if (!view?.entity || !view.fetchXml) { return; }

        const environment = connection.environmentUrl;
        const key = `${environment}\n${view.entity}\n${view.fetchXml}`;
        if (key === this.rowsKey) { return; }
        this.rowsKey = key;
        const seq = ++this.fetchSeq;
        this.rows = { kind: 'loading', environment };
        this.scheduleRefresh();

        this.client.executeFetchXml(view.entity, view.fetchXml, MAX_ROWS).then(
            records => { this.applyRows(seq, { kind: 'rows', records, environment }); },
            err => {
                const message = dataverseErrorMessage(err instanceof Error ? err.message : String(err));
                this.applyRows(seq, { kind: 'error', message, environment });
            },
        );
    }

    private applyRows(seq: number, rows: RowsState): void {
        // A newer fetch (or a connection change) has superseded this one.
        if (this.disposed || seq !== this.fetchSeq) { return; }
        this.rows = rows;
        this.postRender();
    }

    private buildShell(bodyHtml: string): string {
        const nonce = makeNonce();
        const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;background:#fafafa}${FORM_CSS}${VIEW_CSS}</style></head>
<body><div id="root">${bodyHtml}</div>
<script nonce="${nonce}">
const root = document.getElementById('root');
window.addEventListener('message', e => {
  if (e.data && e.data.type === 'render') { root.innerHTML = e.data.html; }
});
acquireVsCodeApi().postMessage({ type: 'ready' });
</script></body></html>`;
    }

    private dispose(): void {
        this.disposed = true;
        clearTimeout(this.refreshTimer);
        clearTimeout(this.fetchTimer);
        ViewPreviewPanel.panels.delete(this.uri.toString());
        this.disposables.forEach(d => d.dispose());
    }
}

function makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) { out += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return out;
}

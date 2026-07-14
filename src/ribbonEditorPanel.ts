import * as vscode from 'vscode';
import type { DataverseClient, RibbonLocationFilter } from './dataverseClient';
import { parseRibbonXml } from './ribbon/ribbonXmlParser';
import { buildRibbonDiffXml } from './ribbon/ribbonXmlBuilder';
import type { RibbonModel } from './ribbon/ribbonModel';
import { log, logError } from './logger';

const RIBBON_LOCATION_LABELS: Record<RibbonLocationFilter, string> = {
    All: 'All',
    Form: 'Main Form',
    HomepageGrid: 'Home Grid',
    SubGrid: 'Sub-Grid',
};

// A Ribbon Workbench-style viewer/editor for a single entity's ribbon, opened via the entity
// explorer's "Edit Ribbon…" context menu action or the `d365.editRibbon` command. Unlike
// EntityExplorerWebviewProvider (a sidebar WebviewView), this is a full editor-area WebviewPanel —
// this codebase's first use of `createWebviewPanel` — so it follows the same conventions
// (nonce-based CSP, post()/handleMessage()) but manages its own panel lifecycle.
//
// Import/publish back to Dataverse is out of scope for now: edits stay in-memory in the webview and
// "Export RibbonDiffXml" just opens the generated XML as a new, unsaved document.
export class RibbonEditorPanel {
    private static readonly panels = new Map<string, RibbonEditorPanel>();

    private readonly panel: vscode.WebviewPanel;
    private model: RibbonModel | undefined;

    // Caches resolved icon data URIs by ribbon image reference ($webresource:… or /_imgs/…).
    // `null` = looked up, none found (don't retry).
    private readonly _iconCache = new Map<string, string | null>();

    static async createOrShow(
        extensionUri: vscode.Uri,
        client: DataverseClient,
        entityLogicalName: string,
        entityDisplayName: string,
        ribbonLocation: RibbonLocationFilter,
    ): Promise<void> {
        // Each location is a materially different ribbon (different tabs/buttons), so it gets its
        // own panel rather than sharing one per entity.
        const key = `${entityLogicalName}:${ribbonLocation}`;
        const existing = RibbonEditorPanel.panels.get(key);
        if (existing) {
            log(`Ribbon editor: revealing existing panel for '${key}'`);
            existing.panel.reveal();
            return;
        }

        log(`Ribbon editor: opening new panel for '${key}'`);

        const locationLabel = RIBBON_LOCATION_LABELS[ribbonLocation];
        const panel = vscode.window.createWebviewPanel(
            'd365.ribbonEditor',
            `Ribbon: ${entityDisplayName || entityLogicalName} (${locationLabel})`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
                    vscode.Uri.joinPath(extensionUri, 'resources'),
                ],
            },
        );

        const editor = new RibbonEditorPanel(panel, extensionUri, client, entityLogicalName, entityDisplayName, ribbonLocation);
        RibbonEditorPanel.panels.set(key, editor);
        panel.onDidDispose(() => RibbonEditorPanel.panels.delete(key));

        await editor.loadRibbon();
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly client: DataverseClient,
        private readonly entityLogicalName: string,
        private readonly entityDisplayName: string,
        private readonly ribbonLocation: RibbonLocationFilter,
    ) {
        this.panel = panel;
        panel.webview.html = buildHtml(panel.webview, extensionUri);
        panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                logError(`ribbon editor ('${this.entityLogicalName}') handling '${String(msg.type)}'`, err);
                vscode.window.showErrorMessage(`D365 ribbon editor error: ${errMsg(err)}`);
            }
        });
    }

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        // Request/response RPC (icon fetching) — see resolveRequest.
        if (msg.kind === 'request') {
            await this.handleRequest(msg as { id: number; op: string; params: Record<string, unknown> });
            return;
        }

        log(`Ribbon editor ('${this.entityLogicalName}'): received '${String(msg.type)}'`);
        switch (msg.type) {
            case 'ready':
                if (this.model) { this.postModel(); }
                break;
            case 'reloadFromServer':
                await this.loadRibbon();
                break;
            case 'exportRibbonDiffXml':
                await this.exportRibbonDiffXml(msg.model as RibbonModel);
                break;
        }
    }

    // ── RPC (request/response) ──────────────────────────────────────────────
    // The webview posts { kind: 'request', id, op, params } and awaits a matching
    // { kind: 'response', id, ok, data|error } — same shape as EntityExplorerWebviewProvider's.

    private async handleRequest(req: { id: number; op: string; params: Record<string, unknown> }): Promise<void> {
        try {
            const data = await this.resolveRequest(req.op, req.params);
            this.post({ kind: 'response', id: req.id, ok: true, data });
        } catch (err) {
            this.post({ kind: 'response', id: req.id, ok: false, error: errMsg(err) });
        }
    }

    private resolveRequest(op: string, params: Record<string, unknown>): Promise<unknown> {
        switch (op) {
            case 'getIcon':
                return this.getIconContent(params.ref as string);
            case 'searchWebResources':
                return this.client.searchWebResources(params.query as string);
            default:
                throw new Error(`Unknown request op: ${op}`);
        }
    }

    private async getIconContent(ref: string): Promise<string | null> {
        if (!ref) { return null; }
        if (this._iconCache.has(ref)) { return this._iconCache.get(ref) ?? null; }

        let content: string | undefined;
        try {
            content = await this.client.getRibbonImageContent(ref);
        } catch {
            content = undefined; // fall through and cache null
        }
        this._iconCache.set(ref, content ?? null);
        return content ?? null;
    }

    private async loadRibbon(): Promise<void> {
        log(`Ribbon editor ('${this.entityLogicalName}'): loading '${this.ribbonLocation}' ribbon XML…`);
        this.post({ type: 'ribbonLoading' });
        try {
            const xml = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `D365: Loading ribbon for '${this.entityLogicalName}'…`, cancellable: false },
                () => this.client.getEntityRibbonXml(this.entityLogicalName, this.ribbonLocation),
            );
            log(`Ribbon editor ('${this.entityLogicalName}'): received ${xml.length} chars of ribbon XML, parsing…`);
            this.model = parseRibbonXml(xml);
            log(`Ribbon editor ('${this.entityLogicalName}'): parsed ${this.model.tabs.length} tab(s), ${this.model.commandDefinitions.length} command definition(s), ${this.model.enableRules.length} enable rule(s), ${this.model.displayRules.length} display rule(s)`);
            this.postModel();
        } catch (err) {
            logError(`ribbon editor ('${this.entityLogicalName}') loadRibbon`, err);
            this.post({ type: 'ribbonError', message: errMsg(err) });
        }
    }

    private postModel(): void {
        this.post({
            type: 'ribbonModel',
            entityLogicalName: this.entityLogicalName,
            entityDisplayName: this.entityDisplayName,
            ribbonLocationLabel: RIBBON_LOCATION_LABELS[this.ribbonLocation],
            model: this.model,
        });
    }

    private async exportRibbonDiffXml(model: RibbonModel): Promise<void> {
        const xml = buildRibbonDiffXml(model);
        log(`Ribbon editor ('${this.entityLogicalName}'): exported RibbonDiffXml (${xml.length} chars)`);
        const doc = await vscode.workspace.openTextDocument({ content: xml, language: 'xml' });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private post(message: unknown): void {
        void this.panel.webview.postMessage(message);
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// ── HTML shell ───────────────────────────────────────────────────────────────
// Same shape as entityExplorerWebview.ts's buildHtml — loads the esbuild-bundled React app for
// this panel (out/webview/ribbonEditor.{js,css}) through a locked-down, nonce-based CSP.

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'ribbonEditor.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'ribbonEditor.css'));

    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `font-src ${webview.cspSource} data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function makeNonce(): string {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

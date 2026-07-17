import * as vscode from 'vscode';
import type { ConnectionManager, DefaultSolutionRef } from './connectionManager';
import type { DataverseClient, Solution } from './dataverseClient';
import type { EntityCache } from './entityCache';
import { generateInterface, generateEnum, toPascalCase, OPTION_SET_TYPES } from './interfaceGenerator';

export class EntityExplorerWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewType = 'd365.entityExplorer';

    private _view: vscode.WebviewView | undefined;

    // Caches base64 SVG content by web resource name. `null` = looked up, none found (don't retry).
    private readonly _iconCache = new Map<string, string | null>();

    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly client: DataverseClient,
        private readonly extensionUri: vscode.Uri,
        private readonly entityCache: EntityCache,
    ) {
        connectionManager.onDidChangeConnection(conn => {
            this.post({ type: 'connectionState', connected: !!conn, restoring: false });
            if (conn) {
                void this.sendEntities();
                const defaultSolution = connectionManager.getDefaultSolution();
                if (defaultSolution) { void this.applySolutionFilter(defaultSolution); }
            }
        });
    }

    // Forces a fresh fetch from the server, bypassing (but still refreshing) the cache -- bound to
    // the "D365: Refresh Entities" command.
    refresh(): void { void this.sendEntities({ forceRefresh: true }); }

    resolveWebviewView(view: vscode.WebviewView): void {
        this._view = view;
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'out', 'webview'),
                vscode.Uri.joinPath(this.extensionUri, 'resources'),
            ],
        };
        view.webview.html = buildHtml(view.webview, this.extensionUri);
        view.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                vscode.window.showErrorMessage(`D365 webview error: ${errMsg(err)}`);
            }
        });
    }

    // ── Message handling ────────────────────────────────────────────────────

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        // Request/response RPC (attributes, icons, …) — see resolveRequest.
        if (msg.kind === 'request') {
            await this.handleRequest(msg as { id: number; op: string; params: Record<string, unknown> });
            return;
        }

        switch (msg.type) {
            case 'ready':
                this.post({ type: 'connectionState', connected: this.connectionManager.isConnected, restoring: this.connectionManager.isRestoring });
                if (this.connectionManager.isConnected) {
                    // Fire-and-forget both, same as the constructor's onDidChangeConnection handler --
                    // awaiting sendEntities() here would delay the filter until its OWN background
                    // refresh finishes (sendEntities doesn't resolve until then, even though it already
                    // posted the cached list synchronously), which is exactly the "shows unfiltered,
                    // then corrects a second later" lag this is meant to fix.
                    void this.sendEntities();
                    // post() silently no-ops while no view is attached, so a solution filter applied
                    // by the constructor's onDidChangeConnection handler (which can fire before the
                    // webview finishes resolving) may never have reached this view. 'ready' only fires
                    // once the webview is actually listening, so re-apply it here to be sure.
                    const defaultSolution = this.connectionManager.getDefaultSolution();
                    if (defaultSolution) { void this.applySolutionFilter(defaultSolution); }
                }
                break;
            case 'connect':
                await this.connectionManager.connect();
                break;
            case 'showSolutionPicker':
                await this.showSolutionPicker();
                break;
            case 'clearSolutionFilter':
                await this.connectionManager.setDefaultSolution(undefined);
                break;
            case 'makeInterface':
                await this.makeInterface(
                    msg.entityLogicalName as string,
                    msg.entityDisplayName as string,
                );
                break;
            case 'makeEnum':
                await this.makeEnum(
                    msg.entityLogicalName as string,
                    msg.attributeLogicalName as string,
                    msg.attributeDisplayName as string,
                    msg.attributeType as string,
                );
                break;
        }
    }

    // Cache-first by default: a cached list (if any) renders immediately while a fresh fetch runs in
    // the background and silently replaces it on success (see 'entitiesRefreshed' in protocol.ts) --
    // this is also what lets entities show up instantly right after an optimistic connection restore,
    // well before the user has even opened this view. `forceRefresh` (the "Refresh Entities" command)
    // skips straight to a blocking fetch, same as when there's no cache yet.
    private async sendEntities(opts: { forceRefresh?: boolean } = {}): Promise<void> {
        const environmentUrl = this.connectionManager.connection?.environmentUrl;
        if (!environmentUrl) { return; }

        this._iconCache.clear(); // icons may differ across environments; refetch on demand
        const cached = opts.forceRefresh ? undefined : this.entityCache.get(environmentUrl);

        if (cached) {
            this.post({ type: 'entities', data: cached });
            this.post({ type: 'entitiesRefreshing' });
            try {
                const fresh = await this.client.getEntities();
                await this.entityCache.set(environmentUrl, fresh);
                this.post({ type: 'entitiesRefreshed', data: fresh });
            } catch {
                // Stale cache is still showing -- don't replace it with an error toast over a silent refresh.
            }
            return;
        }

        this.post({ type: 'entitiesLoading' });
        try {
            const data = await this.client.getEntities();
            await this.entityCache.set(environmentUrl, data);
            this.post({ type: 'entities', data });
        } catch (err) {
            this.post({ type: 'entitiesError', message: errMsg(err) });
        }
    }

    // ── RPC (request/response) ──────────────────────────────────────────────
    // The webview posts { kind: 'request', id, op, params } and awaits a matching
    // { kind: 'response', id, ok, data|error }. Add a new data source by adding an op here.

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
            case 'getAttributes':
                return this.client.getAttributes(params.entityLogicalName as string);
            case 'getIcon':
                return this.getIconContent(params.key as string);
            default:
                throw new Error(`Unknown request op: ${op}`);
        }
    }

    // Resolves a table's SVG icon to its base64 content, or null if it has none. The key selects
    // the source: 'wr:<name>' → an IconVectorName web resource (custom tables); 'otc:<code>' → the
    // built-in /_imgs/svg_<otc>.svg icon (system tables). Failures resolve to null (generic glyph),
    // cached so we don't re-hit the API on repeated views.
    private async getIconContent(key: string): Promise<string | null> {
        if (!key) { return null; }
        if (this._iconCache.has(key)) { return this._iconCache.get(key) ?? null; }

        let content: string | undefined;
        try {
            if (key.startsWith('wr:')) {
                content = await this.client.getWebResourceContentByName(key.slice(3));
            } else if (key.startsWith('otc:')) {
                const otc = Number(key.slice(4));
                if (Number.isFinite(otc)) { content = await this.client.getSystemIconSvg(otc); }
            }
        } catch {
            content = undefined; // fall through and cache null
        }
        this._iconCache.set(key, content ?? null);
        return content ?? null;
    }

    async makeInterface(entityLogicalName: string, entityDisplayName: string): Promise<void> {
        let attributes;
        try {
            attributes = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `D365: Loading fields for '${entityLogicalName}'…`, cancellable: false },
                () => this.client.getAttributes(entityLogicalName),
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to load fields: ${errMsg(err)}`);
            return;
        }

        const picks = await vscode.window.showQuickPick(
            attributes.map(a => ({
                label: a.displayName || a.logicalName,
                description: a.logicalName,
                detail: [
                    a.attributeType,
                    a.isPrimaryId && 'Primary ID',
                    a.isPrimaryName && 'Primary Name',
                ].filter(Boolean).join('  ·  '),
                picked: a.isPrimaryId || a.isPrimaryName,
                attribute: a,
            })),
            {
                title: `Select fields — ${entityDisplayName} (${entityLogicalName})`,
                placeHolder: 'Choose fields to include in the interface…',
                canPickMany: true,
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );

        if (!picks?.length) { return; }

        const selectedAttrs  = picks.map(p => p.attribute);
        const optionSetAttrs = selectedAttrs.filter(a => OPTION_SET_TYPES.has(a.attributeType));

        // Fetch option values for all selected option set fields
        const enumBlocks: string[] = [];
        const enumNames = new Map<string, string>();

        if (optionSetAttrs.length) {
            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'D365: Loading option sets…', cancellable: false },
                    async () => {
                        for (const attr of optionSetAttrs) {
                            const options = await this.client.getAttributeOptions(entityLogicalName, attr.logicalName, attr.attributeType);
                            const enumName = toPascalCase(attr.displayName || attr.logicalName);
                            enumNames.set(attr.logicalName, enumName);
                            enumBlocks.push(generateEnum(attr.logicalName, attr.displayName, options));
                        }
                    },
                );
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to load option sets: ${errMsg(err)}`);
                return;
            }
        }

        const parts: string[] = [
            ...enumBlocks,
            generateInterface(entityLogicalName, entityDisplayName, selectedAttrs, enumNames),
        ];

        const doc = await vscode.workspace.openTextDocument({ content: parts.join('\n\n'), language: 'typescript' });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    async makeEnum(entityLogicalName: string, attributeLogicalName: string, attributeDisplayName: string, attributeType: string): Promise<void> {
        let options;
        try {
            options = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `D365: Loading options for '${attributeDisplayName || attributeLogicalName}'…`, cancellable: false },
                () => this.client.getAttributeOptions(entityLogicalName, attributeLogicalName, attributeType),
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to load option set: ${errMsg(err)}`);
            return;
        }

        const text = generateEnum(attributeLogicalName, attributeDisplayName, options);
        const doc  = await vscode.workspace.openTextDocument({ content: text, language: 'typescript' });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async showSolutionPicker(): Promise<void> {
        let solutions: Solution[];
        try {
            solutions = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'D365: Loading solutions…', cancellable: false },
                () => this.client.getSolutions(),
            );
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to load solutions: ${errMsg(err)}`);
            return;
        }

        const pick = await vscode.window.showQuickPick(
            solutions.map(s => ({ label: s.friendlyName, description: s.uniqueName, solution: s })),
            { title: 'D365: Filter by solution', placeHolder: 'Select a solution…', matchOnDescription: true },
        );
        if (!pick) { return; }

        // The solution used to filter this view doubles as the "default solution" for new components
        // (see webResourceManager.ts's pickSolution) and is re-applied automatically on future connects.
        await this.connectionManager.setDefaultSolution(pick.solution);
        await this.applySolutionFilter(pick.solution, /* showProgress */ true);
    }

    // showProgress is suppressed for the auto-apply-on-connect path so restoring a connection doesn't
    // pop a notification toast on every reload -- only an explicit "Filter by Solution" pick shows one.
    private async applySolutionFilter(solution: DefaultSolutionRef, showProgress = false): Promise<void> {
        const environmentUrl = this.connectionManager.connection?.environmentUrl;
        const cached = environmentUrl ? this.entityCache.getSolutionEntityIds(environmentUrl, solution.solutionId) : undefined;

        if (cached) {
            // Cache-first, same idea as sendEntities: apply immediately (this is what used to lag
            // behind the already-cached entity list on every reload) and silently refresh in the
            // background -- no loading UI, since re-posting solutionFilter is harmless either way.
            this.post({ type: 'solutionFilter', name: solution.friendlyName, entityIds: cached });
            try {
                const fresh = [...await this.client.getSolutionEntityIds(solution.solutionId)];
                await this.entityCache.setSolutionEntityIds(environmentUrl!, solution.solutionId, fresh);
                this.post({ type: 'solutionFilter', name: solution.friendlyName, entityIds: fresh });
            } catch {
                // Stale cache is still applied -- don't surface an error over a silent refresh.
            }
            return;
        }

        const load = () => this.client.getSolutionEntityIds(solution.solutionId);

        let entityIds;
        try {
            entityIds = showProgress
                ? await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'D365: Loading solution components…', cancellable: false },
                    load,
                )
                : await load();
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to load solution components: ${errMsg(err)}`);
            return;
        }

        const ids = [...entityIds];
        if (environmentUrl) { await this.entityCache.setSolutionEntityIds(environmentUrl, solution.solutionId, ids); }
        this.post({ type: 'solutionFilter', name: solution.friendlyName, entityIds: ids });
    }

    private post(message: unknown): void {
        this._view?.webview.postMessage(message);
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}


// ── HTML shell ───────────────────────────────────────────────────────────────
// The UI is a React app bundled by esbuild into out/webview/. This shell only loads that
// bundle and its stylesheet through webview resource URIs under a locked-down CSP; all
// rendering and state now live in src/webview.

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'entityExplorer.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'entityExplorer.css'));

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

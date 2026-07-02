import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from './connectionManager';
import { DataverseClient } from './dataverseClient';
import { EntityExplorerWebviewProvider } from './entityExplorerWebview';
import { D365StatusBar, showD365Menu } from './statusBar';
import { McpBridge } from './mcpBridge';
import { D365CodeActionProvider, D365CompletionProvider, registerInsertInterfaceCommand } from './d365CodeActionProvider';
import {
    publishWebResources,
    publishWebResourcesCommand,
    configureWebResourcesCommand,
    compareWebResource,
    WebResourceContentProvider,
    DIFF_SCHEME,
} from './webResourceManager';

export function activate(context: vscode.ExtensionContext) {
    const connectionManager = new ConnectionManager(context);
    const client = new DataverseClient(connectionManager);
    const explorerProvider = new EntityExplorerWebviewProvider(connectionManager, client);
    const statusBar = new D365StatusBar(connectionManager);
    context.subscriptions.push(statusBar);

    // Keep the d365.connected context variable in sync so view/title menu items show/hide correctly
    connectionManager.onDidChangeConnection(conn => {
        void vscode.commands.executeCommand('setContext', 'd365.connected', !!conn);
    });

    // MCP bridge — lets Claude piggyback on the active connection for schema queries
    const bridge = new McpBridge(connectionManager);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    connectionManager.onDidChangeConnection(conn => {
        if (conn) {
            bridge.start();
            if (workspaceRoot) { ensureMcpJson(workspaceRoot, context.extensionPath); }
        } else {
            bridge.stop();
        }
    });
    context.subscriptions.push(bridge);

    // Also check on activation (covers the case where .mcp.json was deleted and re-opened)
    if (workspaceRoot) {
        ensureMcpJson(workspaceRoot, context.extensionPath);
    }

    // Silently restore the last connection for this workspace
    void connectionManager.tryRestoreConnection();
    statusBar.update(); // reflect the "restoring" state right away (isRestoring is set synchronously above)

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            EntityExplorerWebviewProvider.viewType,
            explorerProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    const docSelector = [
        { language: 'typescript' },
        { language: 'javascript' },
        { language: 'typescriptreact' },
        { language: 'javascriptreact' },
    ];

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            docSelector,
            new D365CodeActionProvider(connectionManager),
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
        ),
        vscode.languages.registerCompletionItemProvider(
            docSelector,
            new D365CompletionProvider(connectionManager),
        ),
    );

    registerInsertInterfaceCommand(context, connectionManager, client);

    const webResourceContentProvider = new WebResourceContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, webResourceContentProvider),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('d365.connect', () => connectionManager.connect()),
        vscode.commands.registerCommand('d365.disconnect', () => connectionManager.disconnect()),
        vscode.commands.registerCommand('d365.switchAccount', () => connectionManager.switchAccount()),
        vscode.commands.registerCommand('d365.statusBarMenu', () => showD365Menu(connectionManager)),
        vscode.commands.registerCommand('d365.refreshEntities', () => explorerProvider.refresh()),
        vscode.commands.registerCommand('d365.browseEntity', () => browseEntity(client)),
        vscode.commands.registerCommand('d365.generateInterface', () =>
            generateInterfaceCommand(client, explorerProvider),
        ),
        vscode.commands.registerCommand('d365.publishWebResource', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
            const targets = uris?.length ? uris : uri ? [uri] : vscode.window.activeTextEditor ? [vscode.window.activeTextEditor.document.uri] : [];
            if (!targets.length) {
                vscode.window.showWarningMessage('D365: No file selected.');
                return;
            }
            return publishWebResources(targets, connectionManager, client);
        }),
        vscode.commands.registerCommand('d365.publishWebResources', () =>
            publishWebResourcesCommand(connectionManager, client),
        ),
        vscode.commands.registerCommand('d365.configureWebResources', () => configureWebResourcesCommand()),
        vscode.commands.registerCommand('d365.compareWebResource', (uri?: vscode.Uri) =>
            compareWebResource(uri, connectionManager, client, webResourceContentProvider),
        ),
    );
}

export function deactivate() {}

// ── Generate interface (command palette) ────────────────────────────────────

async function generateInterfaceCommand(
    client: DataverseClient,
    provider: EntityExplorerWebviewProvider,
): Promise<void> {
    let entities;
    try {
        entities = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'D365: Loading entities…', cancellable: false },
            () => client.getEntities(),
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to load entities: ${errorMessage(err)}`);
        return;
    }

    const pick = await vscode.window.showQuickPick(
        entities.map(e => ({
            label: e.displayName || e.logicalName,
            description: e.logicalName,
            detail: e.isCustom ? 'Custom entity' : undefined,
            entity: e,
        })),
        { title: 'D365: Select entity for interface', placeHolder: 'Type to filter…', matchOnDescription: true },
    );
    if (!pick) { return; }

    await provider.makeInterface(pick.entity.logicalName, pick.entity.displayName);
}

// ── Browse entity (quick-pick) ───────────────────────────────────────────────

async function browseEntity(client: DataverseClient): Promise<void> {
    let entities;
    try {
        entities = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'D365: Loading entities…', cancellable: false },
            () => client.getEntities(),
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to load entities: ${errorMessage(err)}`);
        return;
    }

    const entityPick = await vscode.window.showQuickPick(
        entities.map(e => ({
            label: e.displayName || e.logicalName,
            description: e.logicalName,
            detail: e.isCustom ? 'Custom entity' : undefined,
            entity: e,
        })),
        { title: 'D365: Select an entity', placeHolder: 'Type to filter…', matchOnDescription: true },
    );
    if (!entityPick) { return; }

    let attributes;
    try {
        attributes = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `D365: Loading fields for '${entityPick.entity.logicalName}'…`, cancellable: false },
            () => client.getAttributes(entityPick.entity.logicalName),
        );
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to load attributes: ${errorMessage(err)}`);
        return;
    }

    await vscode.window.showQuickPick(
        attributes.map(a => ({
            label: a.displayName || a.logicalName,
            description: a.logicalName,
            detail: [a.attributeType, a.isPrimaryId && 'Primary ID', a.isPrimaryName && 'Primary Name'].filter(Boolean).join('  ·  '),
            alwaysShow: true,
        })),
        {
            title: `Fields — ${entityPick.entity.displayName} (${entityPick.entity.logicalName})`,
            placeHolder: `${attributes.length} fields  ·  type to filter…`,
            matchOnDescription: true,
            matchOnDetail: true,
        },
    );
}

function ensureMcpJson(workspaceRoot: string, extensionPath: string): void {
    if (!vscode.extensions.getExtension('anthropic.claude-code')) { return; }

    const mcpJsonPath  = path.join(workspaceRoot, '.mcp.json');
    const serverJsPath = path.join(extensionPath, 'out', 'mcp-server.js');

    if (fs.existsSync(mcpJsonPath)) { return; }
    if (!fs.existsSync(serverJsPath)) { return; }

    const config = {
        mcpServers: {
            d365: {
                command: 'node',
                args: [serverJsPath],
            },
        },
    };

    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    vscode.window.showInformationMessage(
        'D365: Created .mcp.json — restart Claude Code to enable Dataverse schema queries.',
    );
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

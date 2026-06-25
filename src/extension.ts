import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { DataverseClient } from './dataverseClient';
import { EntityExplorerWebviewProvider } from './entityExplorerWebview';
import { McpBridge } from './mcpBridge';

export function activate(context: vscode.ExtensionContext) {
    const connectionManager = new ConnectionManager(context);
    const client = new DataverseClient(connectionManager);
    const explorerProvider = new EntityExplorerWebviewProvider(connectionManager, client);

    // Keep the d365.connected context variable in sync so view/title menu items show/hide correctly
    connectionManager.onDidChangeConnection(conn => {
        void vscode.commands.executeCommand('setContext', 'd365.connected', !!conn);
    });

    // MCP bridge — lets Claude piggyback on the active connection for schema queries
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const bridge = new McpBridge(connectionManager, workspaceRoot);
        connectionManager.onDidChangeConnection(conn => {
            if (conn) { bridge.start(); } else { bridge.stop(); }
        });
        context.subscriptions.push(bridge);
    }

    // Silently restore the last connection for this workspace
    void connectionManager.tryRestoreConnection();

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            EntityExplorerWebviewProvider.viewType,
            explorerProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('d365.connect', () => connectionManager.connect()),
        vscode.commands.registerCommand('d365.disconnect', () => connectionManager.disconnect()),
        vscode.commands.registerCommand('d365.refreshEntities', () => explorerProvider.refresh()),
        vscode.commands.registerCommand('d365.browseEntity', () => browseEntity(client)),
        vscode.commands.registerCommand('d365.generateInterface', () =>
            generateInterfaceCommand(client, explorerProvider),
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

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

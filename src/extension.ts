import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConnectionManager } from './connectionManager';
import { DataverseClient } from './dataverseClient';
import { EntityExplorerWebviewProvider } from './entityExplorerWebview';
import { RibbonEditorPanel } from './ribbonEditorPanel';
import { getOutputChannel } from './logger';
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
    context.subscriptions.push(getOutputChannel());

    const connectionManager = new ConnectionManager(context);
    const client = new DataverseClient(connectionManager);
    const explorerProvider = new EntityExplorerWebviewProvider(
        connectionManager,
        client,
        context.extensionUri,
        (logicalName, displayName, ribbonLocation) => void RibbonEditorPanel.createOrShow(context.extensionUri, client, logicalName, displayName, ribbonLocation),
    );
    const statusBar = new D365StatusBar(connectionManager);
    context.subscriptions.push(statusBar);

    // Keep the d365.connected context variable in sync so view/title menu items show/hide correctly
    connectionManager.onDidChangeConnection(conn => {
        void vscode.commands.executeCommand('setContext', 'd365.connected', !!conn);
    });

    // MCP bridge — lets Claude piggyback on the active connection for schema queries.
    // The bridge itself just needs an active connection; the .mcp.json file that wires
    // Claude Code up to it is only written when the user runs "D365: Configure MCP
    // Server for this Workspace" — never automatically.
    const bridge = new McpBridge(connectionManager);

    connectionManager.onDidChangeConnection(conn => {
        if (conn) {
            bridge.start();
        } else {
            bridge.stop();
        }
    });
    context.subscriptions.push(bridge);

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
        vscode.commands.registerCommand('d365.configureMcp', () => configureMcpCommand(context.extensionPath)),
        vscode.commands.registerCommand('d365.editRibbon', () => editRibbonCommand(client, context.extensionUri)),
    );
}

export function deactivate() { }

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

// ── Edit ribbon (command palette) ───────────────────────────────────────────

async function editRibbonCommand(client: DataverseClient, extensionUri: vscode.Uri): Promise<void> {
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
        { title: 'D365: Select entity to edit ribbon', placeHolder: 'Type to filter…', matchOnDescription: true },
    );
    if (!pick) { return; }

    const locationPick = await vscode.window.showQuickPick(
        [
            { label: 'Main Form', filter: 'Form' as const },
            { label: 'Home Grid', filter: 'HomepageGrid' as const },
            { label: 'Sub-Grid', filter: 'SubGrid' as const },
        ],
        { title: `D365: Edit ribbon — ${pick.entity.displayName || pick.entity.logicalName}`, placeHolder: 'Select a ribbon location…' },
    );
    if (!locationPick) { return; }

    await RibbonEditorPanel.createOrShow(extensionUri, client, pick.entity.logicalName, pick.entity.displayName, locationPick.filter);
}

async function configureMcpCommand(extensionPath: string): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('D365: Open a workspace folder before configuring the MCP server.');
        return;
    }

    const serverJsPath = path.join(extensionPath, 'out', 'mcp-server.js');
    if (!fs.existsSync(serverJsPath)) {
        vscode.window.showErrorMessage('D365: MCP server bundle not found in this extension install.');
        return;
    }

    const mcpJsonPath = path.join(workspaceRoot, '.mcp.json');

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(mcpJsonPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) as Record<string, unknown>;
        } catch {
            vscode.window.showErrorMessage('D365: .mcp.json exists but is not valid JSON. Fix or remove it, then retry.');
            return;
        }

        const servers = existing['mcpServers'] as Record<string, unknown> | undefined;
        if (servers?.['d365']) {
            vscode.window.showInformationMessage('D365: MCP server is already configured for this workspace.');
            return;
        }
    }

    const config = {
        ...existing,
        mcpServers: {
            ...(existing['mcpServers'] as Record<string, unknown> | undefined),
            d365: {
                command: 'node',
                args: [serverJsPath],
            },
        },
    };

    try {
        fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch (err) {
        vscode.window.showErrorMessage(`D365: Failed to write .mcp.json: ${errorMessage(err)}`);
        return;
    }

    await ensureGitignoreEntry(workspaceRoot, '.mcp.json');

    vscode.window.showInformationMessage(
        'D365: Configured .mcp.json for this workspace — restart Claude Code to enable Dataverse schema queries.',
    );
}

async function ensureGitignoreEntry(workspaceRoot: string, entry: string): Promise<void> {
    const gitignorePath = path.join(workspaceRoot, '.gitignore');

    if (!fs.existsSync(gitignorePath)) {
        const choice = await vscode.window.showInformationMessage(
            `D365: No .gitignore found in this workspace. Create one and ignore ${entry}?`,
            { modal: true },
            'Yes',
            'No',
        );
        if (choice !== 'Yes') {
            return;
        }

        try {
            fs.writeFileSync(gitignorePath, `${entry}\n`, 'utf8');
        } catch {
            // Best-effort: failure to create .gitignore shouldn't block MCP configuration.
        }
        return;
    }

    try {
        const contents = fs.readFileSync(gitignorePath, 'utf8');
        const alreadyIgnored = contents.split(/\r?\n/).some((line) => line.trim() === entry);
        if (alreadyIgnored) {
            return;
        }

        const separator = contents.length === 0 || contents.endsWith('\n') ? '' : '\n';
        fs.writeFileSync(gitignorePath, `${contents}${separator}${entry}\n`, 'utf8');
    } catch {
        // Best-effort: failure to update .gitignore shouldn't block MCP configuration.
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

import * as vscode from 'vscode';
import { isMcpConfigured, type McpBridge } from './mcpBridge';

// A second status bar item, distinct from D365StatusBar, purely to show whether the MCP bridge
// Claude Code talks to is actually usable right now. Stays hidden entirely until the user has run
// "D365: Configure MCP Server for this Workspace" (i.e. .mcp.json declares a "d365" server) --
// there's nothing useful to show before that.
export class McpStatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly bridge: McpBridge) {
        this.item = vscode.window.createStatusBarItem('d365.mcpStatus', vscode.StatusBarAlignment.Left, 99);
        this.item.name = 'D365 MCP Server';

        this.disposables.push(this.item, bridge.onDidChangeState(() => this.update()));

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolder, '.mcp.json'));
            this.disposables.push(
                watcher,
                watcher.onDidCreate(() => this.update()),
                watcher.onDidChange(() => this.update()),
                watcher.onDidDelete(() => this.update()),
            );
        }

        this.update();
    }

    update(): void {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot || !isMcpConfigured(workspaceRoot)) {
            this.item.hide();
            return;
        }

        if (this.bridge.isRunning) {
            this.item.text = '$(check) MCP Active';
            this.item.tooltip = 'D365 MCP server is running -- Claude Code can query live Dataverse schema.';
        } else {
            this.item.text = '$(circle-slash) MCP Inactive';
            this.item.tooltip = 'D365 MCP server requires an active D365 connection.';
        }
        this.item.show();
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
    }
}

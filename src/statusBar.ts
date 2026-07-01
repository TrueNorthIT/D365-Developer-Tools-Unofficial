import * as vscode from 'vscode';
import { ConnectionManager, StoredConnection } from './connectionManager';

export class D365StatusBar implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly listener: vscode.Disposable;

    constructor(private readonly connectionManager: ConnectionManager) {
        this.item = vscode.window.createStatusBarItem('d365.status', vscode.StatusBarAlignment.Left, 100);
        this.item.name = 'D365';
        this.item.command = 'd365.statusBarMenu';
        this.listener = connectionManager.onDidChangeConnection(() => this.update());
        this.update();
        this.item.show();
    }

    update(): void {
        const conn = this.connectionManager.connection;

        if (this.connectionManager.isRestoring) {
            this.item.text = '$(sync~spin) D365: Reconnecting…';
            this.item.tooltip = 'D365: Restoring previous connection…';
            return;
        }

        if (conn) {
            this.item.text = `$(plug) D365: ${friendlyName(conn.environmentUrl)}`;
            const lines = [
                `**Connected to D365**`,
                conn.environmentUrl,
                conn.authMode === 'user' ? 'Signed in with Microsoft account' : `Client credentials (${conn.clientId})`,
            ];
            if (conn.whoAmI) { lines.push(`User ID: ${conn.whoAmI.UserId}`); }
            lines.push('', 'Click for connection options.');
            this.item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));
        } else {
            this.item.text = '$(debug-disconnect) D365: Not Connected';
            this.item.tooltip = 'Click to connect to a D365 environment';
        }
    }

    dispose(): void {
        this.listener.dispose();
        this.item.dispose();
    }
}

export function friendlyName(environmentUrl: string): string {
    try {
        return new URL(environmentUrl).hostname.split('.')[0];
    } catch {
        return environmentUrl;
    }
}

type MenuItem = vscode.QuickPickItem & { action?: () => void | Promise<void> };

export async function showD365Menu(connectionManager: ConnectionManager): Promise<void> {
    const conn = connectionManager.connection;
    const items: MenuItem[] = [];

    if (conn) {
        items.push({ label: '$(debug-disconnect) Disconnect', description: conn.environmentUrl, action: () => connectionManager.disconnect() });
        if (conn.authMode === 'user') {
            items.push({
                label: '$(account) Switch Account…',
                description: 'Sign in with a different Microsoft account',
                action: () => connectionManager.switchAccount(),
            });
        }
        items.push({
            label: '$(plug) Connect to Different Environment…',
            action: () => connectionManager.connect(),
        });
    } else {
        items.push({ label: '$(plug) Connect to Environment…', action: () => connectionManager.connect() });
    }

    const isCurrent = (r: StoredConnection) =>
        !!conn && conn.environmentUrl === r.environmentUrl && conn.authMode === r.authMode && conn.clientId === r.clientId;

    const recents = connectionManager.getRecentEnvironments().filter(r => !isCurrent(r));

    if (recents.length) {
        items.push({ label: 'Recent Environments', kind: vscode.QuickPickItemKind.Separator });
        for (const recent of recents) {
            items.push({
                label: `$(history) ${friendlyName(recent.environmentUrl)}`,
                description: recent.environmentUrl,
                detail: recent.authMode === 'user' ? 'User account' : `Client credentials · ${recent.clientId}`,
                action: () => connectionManager.connectToStored(recent),
            });
        }
    }

    const pick = await vscode.window.showQuickPick(items, {
        title: 'D365 Developer Tools',
        placeHolder: conn ? `Connected to ${conn.environmentUrl}` : 'Not connected to a D365 environment',
    });

    await pick?.action?.();
}

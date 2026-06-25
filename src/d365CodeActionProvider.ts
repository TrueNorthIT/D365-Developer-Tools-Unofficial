import * as vscode from 'vscode';
import type { AttributeDefinition } from './dataverseClient';
import type { ConnectionManager } from './connectionManager';
import type { DataverseClient } from './dataverseClient';
import { generateInterface, generateEnum, toPascalCase, OPTION_SET_TYPES } from './interfaceGenerator';

// Matches:  // @d365 account   or   // @d365 lead
const TRIGGER_RE = /^(\s*)\/\/\s*@d365\s+(\S+)\s*$/;

export class D365CodeActionProvider implements vscode.CodeActionProvider {
    constructor(
        private readonly connectionManager: ConnectionManager,
        private readonly client: DataverseClient,
    ) {}

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
        const line  = document.lineAt(range.start.line);
        const match = TRIGGER_RE.exec(line.text);
        if (!match) { return []; }

        const entityLogicalName = match[2];
        const connected         = this.connectionManager.isConnected;
        const suffix            = connected ? '' : ' (connect first)';

        const allFields = new vscode.CodeAction(
            `D365: Generate interface for '${entityLogicalName}'${suffix}`,
            vscode.CodeActionKind.QuickFix,
        );
        allFields.command = {
            command:   'd365.codeAction.insertInterface',
            title:     'Generate D365 Interface',
            arguments: [document.uri, line.lineNumber, entityLogicalName, false],
        };
        allFields.isPreferred = connected;

        const selectFields = new vscode.CodeAction(
            `D365: Generate interface for '${entityLogicalName}' (select fields…)${suffix}`,
            vscode.CodeActionKind.QuickFix,
        );
        selectFields.command = {
            command:   'd365.codeAction.insertInterface',
            title:     'Generate D365 Interface (select fields)',
            arguments: [document.uri, line.lineNumber, entityLogicalName, true],
        };

        return [allFields, selectFields];
    }
}

export function registerInsertInterfaceCommand(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    client: DataverseClient,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'd365.codeAction.insertInterface',
            async (uri: vscode.Uri, lineNumber: number, entityLogicalName: string, selectFields: boolean) => {
                if (!connectionManager.isConnected) {
                    vscode.window.showErrorMessage('D365: Connect to an environment before generating interfaces.');
                    return;
                }

                let allAttributes: AttributeDefinition[];
                try {
                    allAttributes = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `D365: Loading '${entityLogicalName}'…`, cancellable: false },
                        () => client.getAttributes(entityLogicalName),
                    );
                } catch {
                    vscode.window.showErrorMessage(`D365: Entity '${entityLogicalName}' not found or failed to load.`);
                    return;
                }

                let attributes = allAttributes;

                if (selectFields) {
                    const picks = await vscode.window.showQuickPick(
                        allAttributes.map(a => ({
                            label:       a.displayName || a.logicalName,
                            description: a.logicalName,
                            detail:      [
                                a.attributeType,
                                a.isPrimaryId   && 'Primary ID',
                                a.isPrimaryName && 'Primary Name',
                            ].filter(Boolean).join('  ·  '),
                            picked:    a.isPrimaryId || a.isPrimaryName,
                            attribute: a,
                        })),
                        {
                            title:             `Select fields — ${entityLogicalName}`,
                            placeHolder:       'Choose fields to include…',
                            canPickMany:       true,
                            matchOnDescription: true,
                            matchOnDetail:      true,
                        },
                    );
                    if (!picks?.length) { return; }
                    attributes = picks.map(p => p.attribute);
                }

                const optionSetAttrs = attributes.filter(a => OPTION_SET_TYPES.has(a.attributeType));
                const enumBlocks: string[] = [];
                const enumNames = new Map<string, string>();

                if (optionSetAttrs.length) {
                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'D365: Loading option sets…', cancellable: false },
                        async () => {
                            for (const attr of optionSetAttrs) {
                                try {
                                    const options = await client.getAttributeOptions(entityLogicalName, attr.logicalName, attr.attributeType);
                                    enumNames.set(attr.logicalName, toPascalCase(attr.displayName || attr.logicalName));
                                    enumBlocks.push(generateEnum(attr.logicalName, attr.displayName, options));
                                } catch { /* fall back to number type */ }
                            }
                        },
                    );
                }

                const generated = [
                    ...enumBlocks,
                    generateInterface(entityLogicalName, entityLogicalName, attributes, enumNames),
                ].join('\n\n');

                // Re-read the document at insertion time and preserve indentation
                const document = await vscode.workspace.openTextDocument(uri);
                const line     = document.lineAt(lineNumber);
                const indent   = TRIGGER_RE.exec(line.text)?.[1] ?? '';
                const indented = indent
                    ? generated.split('\n').map(l => l && indent + l).join('\n')
                    : generated;

                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, line.range, indented);
                await vscode.workspace.applyEdit(edit);
            },
        ),
    );
}

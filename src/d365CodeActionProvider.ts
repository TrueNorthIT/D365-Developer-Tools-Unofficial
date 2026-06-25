import * as vscode from 'vscode';
import type { AttributeDefinition } from './dataverseClient';
import type { ConnectionManager } from './connectionManager';
import type { DataverseClient } from './dataverseClient';
import { generateInterface, generateEnum, toPascalCase, OPTION_SET_TYPES } from './interfaceGenerator';

// Matches:  // @d365 account   or   // @d365 lead
const TRIGGER_RE = /^(\s*)\/\/\s*@d365\s+(\S+)\s*$/;

// ── Completion provider ───────────────────────────────────────────────────────
// Activated by Ctrl+Space (or quick suggestions) on a `// @d365 <entity>` line.
// Returns two items — one for all fields, one for a field picker — that each
// clear the trigger comment and run the generation command.

export class D365CompletionProvider implements vscode.CompletionItemProvider {
    constructor(
        private readonly connectionManager: ConnectionManager,
    ) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] {
        const line  = document.lineAt(position.line);
        const match = TRIGGER_RE.exec(line.text);
        if (!match) { return []; }

        const indent            = match[1];
        const entityLogicalName = match[2];
        const connected         = this.connectionManager.isConnected;
        const suffix            = connected ? '' : ' — connect first';

        const make = (label: string, selectFields: boolean, sort: string): vscode.CompletionItem => {
            const item        = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);
            item.detail       = 'D365 Dataverse';
            item.filterText   = entityLogicalName;    // show when typing the entity name
            item.sortText     = sort;                 // float above other suggestions
            item.insertText   = '';                   // the command handles all text changes
            item.range        = line.range;           // clear the trigger comment on accept
            item.command      = {
                command:   'd365.codeAction.insertInterface',
                title:     label,
                arguments: [document.uri, line.lineNumber, entityLogicalName, selectFields, indent],
            };
            return item;
        };

        return [
            make(`D365: Generate interface for '${entityLogicalName}'${suffix}`,              false, '00'),
            make(`D365: Generate interface for '${entityLogicalName}' (select fields…)${suffix}`, true,  '01'),
        ];
    }
}

// ── Code action provider (lightbulb) ─────────────────────────────────────────
// Kept alongside the completion provider so the options also appear in the
// lightbulb menu for users who prefer that workflow.

export class D365CodeActionProvider implements vscode.CodeActionProvider {
    constructor(
        private readonly connectionManager: ConnectionManager,
    ) {}

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
        const line  = document.lineAt(range.start.line);
        const match = TRIGGER_RE.exec(line.text);
        if (!match) { return []; }

        const indent            = match[1];
        const entityLogicalName = match[2];
        const connected         = this.connectionManager.isConnected;
        const suffix            = connected ? '' : ' (connect first)';

        const make = (label: string, selectFields: boolean, preferred: boolean): vscode.CodeAction => {
            const action     = new vscode.CodeAction(`D365: ${label}${suffix}`, vscode.CodeActionKind.QuickFix);
            action.command   = {
                command:   'd365.codeAction.insertInterface',
                title:     label,
                arguments: [document.uri, line.lineNumber, entityLogicalName, selectFields, indent],
            };
            action.isPreferred = preferred && connected;
            return action;
        };

        return [
            make(`Generate interface for '${entityLogicalName}'`,              false, true),
            make(`Generate interface for '${entityLogicalName}' (select fields…)`, true,  false),
        ];
    }
}

// ── Shared command ────────────────────────────────────────────────────────────

export function registerInsertInterfaceCommand(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    client: DataverseClient,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'd365.codeAction.insertInterface',
            async (uri: vscode.Uri, lineNumber: number, entityLogicalName: string, selectFields: boolean, indent: string) => {
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
                            label:              a.displayName || a.logicalName,
                            description:        a.logicalName,
                            detail:             [
                                a.attributeType,
                                a.isPrimaryId   && 'Primary ID',
                                a.isPrimaryName && 'Primary Name',
                            ].filter(Boolean).join('  ·  '),
                            picked:             a.isPrimaryId || a.isPrimaryName,
                            attribute:          a,
                        })),
                        {
                            title:              `Select fields — ${entityLogicalName}`,
                            placeHolder:        'Choose fields to include…',
                            canPickMany:        true,
                            matchOnDescription: true,
                            matchOnDetail:      true,
                        },
                    );
                    if (!picks?.length) { return; }
                    attributes = picks.map(p => p.attribute);
                }

                const optionSetAttrs = attributes.filter(a => OPTION_SET_TYPES.has(a.attributeType));
                const enumBlocks: string[] = [];
                const enumNames  = new Map<string, string>();

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

                const indented = indent
                    ? generated.split('\n').map(l => l && indent + l).join('\n')
                    : generated;

                // The completion item already cleared the trigger line via insertText:''.
                // The code action leaves it intact. Either way, replace whatever is on
                // lineNumber now with the generated output.
                const document = await vscode.workspace.openTextDocument(uri);
                const line     = document.lineAt(lineNumber);
                const edit     = new vscode.WorkspaceEdit();
                edit.replace(uri, line.range, indented);
                await vscode.workspace.applyEdit(edit);
            },
        ),
    );
}

import * as vscode from 'vscode';
import type { AttributeDefinition } from './dataverseClient';
import type { ConnectionManager } from './connectionManager';
import type { DataverseClient } from './dataverseClient';
import { generateInterface, generateEnum, toPascalCase, OPTION_SET_TYPES } from './interfaceGenerator';

// Matches:  // @d365 account   or   // @d365 lead  (for the lightbulb path)
const TRIGGER_RE = /^(\s*)\/\/\s*@d365\s+(\S+)\s*$/;

// ── Completion provider ───────────────────────────────────────────────────────
// Fires when the user types `d365` anywhere in a TS/JS file.
// Two items appear filtered to that prefix; selecting either prompts for an
// entity then (optionally) fields, then inserts the generated code in-place.

export class D365CompletionProvider implements vscode.CompletionItemProvider {
    constructor(private readonly connectionManager: ConnectionManager) {}

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] {
        // Match the word being typed, allowing d365 followed by any word chars
        const wordRange = document.getWordRangeAtPosition(position, /d365\w*/i);
        if (!wordRange) { return []; }

        // Don't duplicate on @d365 trigger lines — the lightbulb handles those
        if (TRIGGER_RE.test(document.lineAt(position.line).text)) { return []; }

        const connected = this.connectionManager.isConnected;
        const suffix    = connected ? '' : ' — connect first';

        const make = (label: string, selectFields: boolean, sort: string): vscode.CompletionItem => {
            const item      = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);
            item.detail     = 'D365 Dataverse';
            item.filterText = document.getText(wordRange);
            item.sortText   = sort;
            item.insertText = '';      // clear the `d365` word; command handles the rest
            item.range      = wordRange;
            item.command    = {
                command:   'd365.codeAction.insertInterface',
                title:     label,
                // entityLogicalName: null → command will prompt for entity
                // character >= 0 → insert at position rather than replace a line
                arguments: [document.uri, wordRange.start.line, wordRange.start.character, null, selectFields, ''],
            };
            return item;
        };

        return [
            make(`D365: Generate interface…${suffix}`,              false, '00'),
            make(`D365: Generate interface (select fields…)${suffix}`, true,  '01'),
        ];
    }
}

// ── Code action provider (lightbulb) ─────────────────────────────────────────
// Fires on `// @d365 <entityname>` lines — entity is already known, no picker.

export class D365CodeActionProvider implements vscode.CodeActionProvider {
    constructor(private readonly connectionManager: ConnectionManager) {}

    provideCodeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
        const line  = document.lineAt(range.start.line);
        const match = TRIGGER_RE.exec(line.text);
        if (!match) { return []; }

        const indent            = match[1];
        const entityLogicalName = match[2];
        const connected         = this.connectionManager.isConnected;
        const suffix            = connected ? '' : ' (connect first)';

        const make = (label: string, selectFields: boolean, preferred: boolean): vscode.CodeAction => {
            const action   = new vscode.CodeAction(`D365: ${label}${suffix}`, vscode.CodeActionKind.QuickFix);
            // character: -1 signals "replace the whole line"
            action.command = {
                command:   'd365.codeAction.insertInterface',
                title:     label,
                arguments: [document.uri, line.lineNumber, -1, entityLogicalName, selectFields, indent],
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

// ── Shared generation command ─────────────────────────────────────────────────
// Args: uri, line, character, entityLogicalName | null, selectFields, indent
//   character = -1  → replace the whole trigger line (code action path)
//   character >= 0  → insert at (line, character) after word was cleared (completion path)
//   entityLogicalName = null → prompt the user to pick an entity first

export function registerInsertInterfaceCommand(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    client: DataverseClient,
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'd365.codeAction.insertInterface',
            async (
                uri: vscode.Uri,
                lineNumber: number,
                character: number,
                entityLogicalName: string | null,
                selectFields: boolean,
                indent: string,
            ) => {
                if (!connectionManager.isConnected) {
                    vscode.window.showErrorMessage('D365: Connect to an environment before generating interfaces.');
                    return;
                }

                // ── Entity selection (completion path only) ───────────────────
                if (entityLogicalName === null) {
                    let entities;
                    try {
                        entities = await vscode.window.withProgress(
                            { location: vscode.ProgressLocation.Notification, title: 'D365: Loading entities…', cancellable: false },
                            () => client.getEntities(),
                        );
                    } catch {
                        vscode.window.showErrorMessage('D365: Failed to load entities.');
                        return;
                    }

                    const pick = await vscode.window.showQuickPick(
                        entities.map(e => ({
                            label:       e.displayName || e.logicalName,
                            description: e.logicalName,
                            detail:      e.isCustom ? 'Custom entity' : undefined,
                            entity:      e,
                        })),
                        { title: 'D365: Select entity', placeHolder: 'Type to filter…', matchOnDescription: true },
                    );
                    if (!pick) { return; }
                    entityLogicalName = pick.entity.logicalName;
                }

                // ── Load attributes ───────────────────────────────────────────
                let allAttributes: AttributeDefinition[];
                try {
                    allAttributes = await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: `D365: Loading '${entityLogicalName}'…`, cancellable: false },
                        () => client.getAttributes(entityLogicalName!),
                    );
                } catch {
                    vscode.window.showErrorMessage(`D365: Entity '${entityLogicalName}' not found or failed to load.`);
                    return;
                }

                // ── Field selection (optional) ────────────────────────────────
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

                // ── Generate enums + interface ────────────────────────────────
                const optionSetAttrs = attributes.filter(a => OPTION_SET_TYPES.has(a.attributeType));
                const enumBlocks: string[] = [];
                const enumNames  = new Map<string, string>();

                if (optionSetAttrs.length) {
                    await vscode.window.withProgress(
                        { location: vscode.ProgressLocation.Notification, title: 'D365: Loading option sets…', cancellable: false },
                        async () => {
                            for (const attr of optionSetAttrs) {
                                try {
                                    const options = await client.getAttributeOptions(entityLogicalName!, attr.logicalName, attr.attributeType);
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

                // ── Insert or replace ─────────────────────────────────────────
                const document = await vscode.workspace.openTextDocument(uri);
                const edit     = new vscode.WorkspaceEdit();

                if (character === -1) {
                    // Code action path: replace the entire trigger line
                    edit.replace(uri, document.lineAt(lineNumber).range, indented);
                } else {
                    // Completion path: `d365` word was already cleared; insert at its former position
                    edit.insert(uri, new vscode.Position(lineNumber, character), indented);
                }

                await vscode.workspace.applyEdit(edit);
            },
        ),
    );
}

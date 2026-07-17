/**
 * Minimal hand-written stand-in for the `vscode` module, used so unit tests can
 * exercise files that `import * as vscode from 'vscode'` without launching a real
 * VS Code Extension Host. Only the surface area actually used by src/** is implemented.
 *
 * Wired in via test/mocks/register.js, which intercepts require('vscode') and
 * returns this module instead. Tests can stub individual methods (window.showQuickPick,
 * etc.) with sinon since everything here is a plain object/class, and should call
 * resetVscodeMock() in afterEach to restore defaults.
 */

// ── Disposable / EventEmitter ────────────────────────────────────────────────

export class Disposable {
    constructor(private readonly fn?: () => void) {}
    dispose(): void { this.fn?.(); }
    static from(...items: Array<{ dispose(): void }>): Disposable {
        return new Disposable(() => items.forEach(i => i.dispose()));
    }
}

export class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void): Disposable => {
        this.listeners.push(listener);
        return new Disposable(() => {
            this.listeners = this.listeners.filter(l => l !== listener);
        });
    };
    fire(data: T): void {
        for (const l of [...this.listeners]) { l(data); }
    }
    dispose(): void { this.listeners = []; }
}

// ── Uri ───────────────────────────────────────────────────────────────────────

export class Uri {
    readonly authority = '';
    readonly query = '';
    readonly fragment = '';

    private constructor(
        public readonly scheme: string,
        public readonly fsPath: string,
        private readonly raw: string,
    ) {}

    static file(fsPath: string): Uri {
        return new Uri('file', fsPath, fsPath);
    }

    static parse(value: string): Uri {
        const idx = value.indexOf(':');
        const scheme = idx >= 0 ? value.slice(0, idx) : '';
        const rest = idx >= 0 ? value.slice(idx + 1) : value;
        return new Uri(scheme, rest, value);
    }

    static joinPath(base: Uri, ...segments: string[]): Uri {
        const joined = [base.fsPath, ...segments].join('/').replace(/\/+/g, '/');
        return new Uri(base.scheme, joined, joined);
    }

    get path(): string { return this.fsPath; }

    with(change: { scheme?: string; fsPath?: string }): Uri {
        return new Uri(change.scheme ?? this.scheme, change.fsPath ?? this.fsPath, this.raw);
    }

    toJSON(): unknown { return this; }

    toString(): string { return this.raw; }
}

// ── Position / Range ─────────────────────────────────────────────────────────

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(public readonly start: Position, public readonly end: Position) {}
}

// ── Enums / kind classes ─────────────────────────────────────────────────────

export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
export enum CompletionItemKind { Text = 0, Function = 2 }
export enum QuickPickItemKind { Separator = -1, Default = 0 }
export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }

export class CodeActionKind {
    static readonly QuickFix = new CodeActionKind('quickfix');
    private constructor(public readonly value: string) {}
}

export class CodeAction {
    command: unknown;
    isPreferred: boolean | undefined;
    constructor(public title: string, public kind?: CodeActionKind) {}
}

export class CompletionItem {
    detail?: string;
    filterText?: string;
    sortText?: string;
    insertText?: string;
    range?: unknown;
    command?: unknown;
    constructor(public label: string, public kind?: CompletionItemKind) {}
}

export class MarkdownString {
    value: string;
    constructor(value?: string) { this.value = value ?? ''; }
    appendMarkdown(v: string): this { this.value += v; return this; }
}

export class ThemeIcon {
    constructor(public id: string) {}
}

export class RelativePattern {
    constructor(public base: unknown, public pattern: string) {}
}

export class FileSystemWatcherMock {
    private readonly _onDidCreate = new EventEmitter<Uri>();
    private readonly _onDidChange = new EventEmitter<Uri>();
    private readonly _onDidDelete = new EventEmitter<Uri>();

    onDidCreate = this._onDidCreate.event;
    onDidChange = this._onDidChange.event;
    onDidDelete = this._onDidDelete.event;

    dispose(): void {}

    // test helpers
    triggerCreate(uri: Uri = Uri.file('')): void { this._onDidCreate.fire(uri); }
    triggerChange(uri: Uri = Uri.file('')): void { this._onDidChange.fire(uri); }
    triggerDelete(uri: Uri = Uri.file('')): void { this._onDidDelete.fire(uri); }
}

export class WorkspaceEdit {
    readonly edits: Array<{ type: 'replace' | 'insert'; uri: Uri; range?: Range; position?: Position; text: string }> = [];
    replace(uri: Uri, range: Range, text: string): void { this.edits.push({ type: 'replace', uri, range, text }); }
    insert(uri: Uri, position: Position, text: string): void { this.edits.push({ type: 'insert', uri, position, text }); }
}

// ── InputBox ──────────────────────────────────────────────────────────────────

export class InputBoxMock {
    title = '';
    prompt = '';
    value = '';
    placeholder = '';
    buttons: Array<{ iconPath?: unknown; tooltip?: string }> = [];

    private readonly _onDidAccept = new EventEmitter<void>();
    private readonly _onDidHide = new EventEmitter<void>();
    private readonly _onDidTriggerButton = new EventEmitter<{ iconPath?: unknown; tooltip?: string }>();

    onDidAccept = this._onDidAccept.event;
    onDidHide = this._onDidHide.event;
    onDidTriggerButton = this._onDidTriggerButton.event;

    show(): void {}
    hide(): void { this._onDidHide.fire(); }
    dispose(): void {}

    // test helpers
    triggerAccept(): void { this._onDidAccept.fire(); }
    triggerButton(btn: { iconPath?: unknown; tooltip?: string } = {}): void { this._onDidTriggerButton.fire(btn); }
}

// ── QuickPick (manual, not showQuickPick's promise-returning helper) ──────────

export class QuickPickMock<T = any> {
    title = '';
    placeholder = '';
    items: T[] = [];
    activeItems: T[] = [];
    selectedItems: T[] = [];

    private readonly _onDidAccept = new EventEmitter<void>();
    private readonly _onDidHide = new EventEmitter<void>();

    onDidAccept = this._onDidAccept.event;
    onDidHide = this._onDidHide.event;

    show(): void {}
    hide(): void { this._onDidHide.fire(); }
    dispose(): void {}

    // test helpers
    triggerAccept(selected: T[] = this.activeItems): void {
        this.selectedItems = selected;
        this._onDidAccept.fire();
    }
}

// ── Configuration ─────────────────────────────────────────────────────────────

class ConfigurationMock {
    constructor(private readonly values: Record<string, unknown>) {}
    get<T>(key: string, defaultValue?: T): T {
        return (key in this.values ? this.values[key] : defaultValue) as T;
    }
    async update(key: string, value: unknown): Promise<void> {
        this.values[key] = value;
    }
}

let configValues: Record<string, Record<string, unknown>> = {};

export function __setConfig(section: string, values: Record<string, unknown>): void {
    configValues[section] = { ...values };
}

// ── workspace ─────────────────────────────────────────────────────────────────

export interface WorkspaceFolder { uri: Uri; name: string; index: number }

export const workspace = {
    workspaceFolders: undefined as WorkspaceFolder[] | undefined,

    getConfiguration(section?: string): ConfigurationMock {
        return new ConfigurationMock(configValues[section ?? ''] ?? {});
    },

    getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
        return workspace.workspaceFolders?.find(f => uri.fsPath.startsWith(f.uri.fsPath));
    },

    asRelativePath(uri: Uri): string { return uri.fsPath; },

    findFiles: async (_include?: unknown, _exclude?: unknown, _maxResults?: number): Promise<Uri[]> => [],

    fs: {
        stat: async (_uri: Uri): Promise<{ type: FileType }> => ({ type: FileType.File }),
    },

    createFileSystemWatcher: (..._args: any[]): FileSystemWatcherMock => new FileSystemWatcherMock(),

    openTextDocument: async (uri: Uri) => ({
        uri,
        lineAt: (n: number) => ({ lineNumber: n, text: '', range: new Range(new Position(n, 0), new Position(n, 0)) }),
    }),

    applyEdit: async (_edit: WorkspaceEdit): Promise<boolean> => true,

    registerTextDocumentContentProvider: (): Disposable => new Disposable(),
};

// ── window ────────────────────────────────────────────────────────────────────

export const window = {
    activeTextEditor: undefined as { document: { uri: Uri } } | undefined,

    showInformationMessage: async (..._args: any[]): Promise<string | undefined> => undefined,
    showErrorMessage: async (..._args: any[]): Promise<string | undefined> => undefined,
    showWarningMessage: async (..._args: any[]): Promise<string | undefined> => undefined,
    showQuickPick: async (..._args: any[]): Promise<any> => undefined,
    showInputBox: async (..._args: any[]): Promise<string | undefined> => undefined,
    showOpenDialog: async (..._args: any[]): Promise<Uri[] | undefined> => undefined,
    showTextDocument: async (..._args: any[]): Promise<unknown> => undefined,

    withProgress: async (_options: unknown, task: (progress: { report: (v: unknown) => void }) => unknown) =>
        task({ report: () => {} }),

    createStatusBarItem: (..._args: any[]) => ({
        name: '', text: '', tooltip: undefined as unknown, command: undefined as unknown,
        show() {}, hide() {}, dispose() {},
    }),

    createInputBox: (): InputBoxMock => new InputBoxMock(),

    createQuickPick: (): QuickPickMock => new QuickPickMock(),

    registerWebviewViewProvider: (): Disposable => new Disposable(),
};

// ── commands / languages ────────────────────────────────────────────────────

export const commands = {
    registerCommand: (..._args: any[]): Disposable => new Disposable(),
    executeCommand: async (..._args: any[]): Promise<unknown> => undefined,
};

export const languages = {
    registerCodeActionsProvider: (..._args: any[]): Disposable => new Disposable(),
    registerCompletionItemProvider: (..._args: any[]): Disposable => new Disposable(),
};

export const authentication = {
    getSession: async (..._args: any[]): Promise<{ accessToken: string } | undefined> => undefined,
};

// ── test reset helper ────────────────────────────────────────────────────────

export function resetVscodeMock(): void {
    configValues = {};
    workspace.workspaceFolders = undefined;
    window.activeTextEditor = undefined;
}

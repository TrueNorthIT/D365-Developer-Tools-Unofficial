import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionManager } from './connectionManager';
import type { DataverseClient } from './dataverseClient';
import type { Solution } from './dataverseClient';

// ── Web resource type mapping ───────────────────────────────────────────────

const TYPE_BY_EXTENSION: Record<string, number> = {
    html: 1, htm: 1,
    css:  2,
    js:   3,
    xml:  4,
    png:  5,
    jpg:  6, jpeg: 6,
    gif:  7,
    xap:  8,
    resx: 9,
    svg:  10,
    ico:  11,
};

const TYPE_LABELS: Record<number, string> = {
    1: 'Webpage (HTML)',
    2: 'Style Sheet (CSS)',
    3: 'Script (JScript)',
    4: 'Data (XML)',
    5: 'PNG format',
    6: 'JPG format',
    7: 'GIF format',
    8: 'Silverlight (XAP)',
    9: 'String (RESX)',
    10: 'Vector format (SVG)',
    11: 'ICO format',
};

const SUPPORTED_EXTENSIONS = Object.keys(TYPE_BY_EXTENSION);

// ── Public entry points ─────────────────────────────────────────────────────

// Publish a set of files/folders (from an Explorer selection or the editor title button).
export async function publishWebResources(
    uris: vscode.Uri[],
    connectionManager: ConnectionManager,
    client: DataverseClient,
): Promise<void> {
    if (!connectionManager.isConnected) {
        vscode.window.showErrorMessage('D365: Connect to an environment first.');
        return;
    }

    const files = await expandToFiles(uris);
    if (!files.length) {
        vscode.window.showWarningMessage('D365: No supported web resource files found.');
        return;
    }

    await runPublish(files, client);
}

// Guided setup for the web resources root folder and name prefix, triggered from the D365 Explorer view title menu.
export async function configureWebResourcesCommand(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showWarningMessage('D365: Open a workspace folder first.');
        return;
    }

    const config = vscode.workspace.getConfiguration('d365.webResources', workspaceFolder.uri);
    const currentRoot   = config.get<string>('rootFolder') || 'webresources';
    const currentPrefix = config.get<string>('namePrefix') ?? '';

    const rootFolder = await promptForRootFolder(workspaceFolder, currentRoot);
    if (rootFolder === undefined) { return; }

    const rawNamePrefix = await vscode.window.showInputBox({
        title: 'D365: Web resource name prefix',
        prompt: "Prepended to a file's relative path to form its Dataverse web resource name (a trailing '/' is added automatically)",
        value: currentPrefix,
        placeHolder: "e.g. new_  (leave blank for none)",
    });
    if (rawNamePrefix === undefined) { return; }
    const namePrefix = normalizeNamePrefix(rawNamePrefix);

    const target = vscode.ConfigurationTarget.WorkspaceFolder;
    await config.update('rootFolder', rootFolder || undefined, target);
    await config.update('namePrefix', namePrefix, target);

    vscode.window.showInformationMessage(
        `D365: Web resources folder set to '${rootFolder || 'webresources'}'${namePrefix ? ` with prefix '${namePrefix}'` : ''}.`,
    );
}

function promptForRootFolder(workspaceFolder: vscode.WorkspaceFolder, current: string): Promise<string | undefined> {
    return new Promise(resolve => {
        const box = vscode.window.createInputBox();
        box.title = 'D365: Web resources folder';
        box.prompt = 'Workspace-relative folder containing your web resource files';
        box.value = current;
        box.placeholder = 'webresources';
        box.buttons = [{ iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Browse…' }];

        let resolved = false;

        box.onDidTriggerButton(async () => {
            const picked = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                defaultUri: workspaceFolder.uri,
                openLabel: 'Select Web Resources Folder',
            });
            if (picked?.length) {
                const rel = path.relative(workspaceFolder.uri.fsPath, picked[0].fsPath).split(path.sep).join('/');
                box.value = rel.startsWith('..') ? current : rel;
            }
        });

        box.onDidAccept(() => {
            resolved = true;
            box.hide();
            resolve(box.value.trim());
        });

        box.onDidHide(() => {
            if (!resolved) { resolve(undefined); }
            box.dispose();
        });

        box.show();
    });
}

// Command-palette entry point: lets the user pick from files under the configured web resources root.
export async function publishWebResourcesCommand(
    connectionManager: ConnectionManager,
    client: DataverseClient,
): Promise<void> {
    if (!connectionManager.isConnected) {
        vscode.window.showErrorMessage('D365: Connect to an environment first.');
        return;
    }

    const candidates = await findCandidateFiles();
    if (!candidates.length) {
        vscode.window.showWarningMessage('D365: No files found under the configured web resources root folder.');
        return;
    }

    const picks = await vscode.window.showQuickPick(
        candidates.map(uri => ({ label: vscode.workspace.asRelativePath(uri, false), uri })),
        { canPickMany: true, title: 'D365: Select web resources to publish', placeHolder: 'Type to filter…' },
    );
    if (!picks?.length) { return; }

    await runPublish(picks.map(p => p.uri), client);
}

// ── Orchestration ────────────────────────────────────────────────────────────

async function runPublish(files: vscode.Uri[], client: DataverseClient): Promise<void> {
    const publishedIds: string[] = [];
    const errors: string[] = [];

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'D365: Publishing web resources', cancellable: false },
        async progress => {
            for (const file of files) {
                progress.report({ message: vscode.workspace.asRelativePath(file, false) });
                try {
                    const id = await publishSingleFile(file, client);
                    if (id) { publishedIds.push(id); }
                } catch (err) {
                    errors.push(`${vscode.workspace.asRelativePath(file, false)}: ${errorMessage(err)}`);
                }
            }

            if (publishedIds.length) {
                progress.report({ message: 'Publishing changes…' });
                try {
                    await client.publishWebResources(publishedIds);
                } catch (err) {
                    errors.push(`Publish step failed: ${errorMessage(err)}`);
                }
            }
        },
    );

    if (errors.length) {
        vscode.window.showErrorMessage(
            `D365: ${publishedIds.length} published, ${errors.length} failed.\n${errors.join('\n')}`,
        );
    } else if (publishedIds.length) {
        vscode.window.showInformationMessage(`D365: Published ${publishedIds.length} web resource(s).`);
    }
}

async function publishSingleFile(fileUri: vscode.Uri, client: DataverseClient): Promise<string | undefined> {
    const name = toWebResourceName(fileUri);
    if (!name) {
        throw new Error('File is not under the configured web resources root folder (see d365.webResources.rootFolder).');
    }

    const guessedType = guessType(fileUri.fsPath);
    if (!guessedType) {
        throw new Error(`Unsupported web resource file type: ${path.extname(fileUri.fsPath)}`);
    }

    const buffer = await fs.promises.readFile(fileUri.fsPath);
    const contentBase64 = buffer.toString('base64');

    const existingId = await client.getWebResourceIdByName(name);
    if (existingId) {
        await client.updateWebResourceContent(existingId, contentBase64);
        return existingId;
    }

    const create = await vscode.window.showWarningMessage(
        `Web resource '${name}' does not exist yet. Create it?`,
        { modal: true },
        'Create',
    );
    if (create !== 'Create') { return undefined; }

    const displayName = await vscode.window.showInputBox({
        title: `Display name for ${name}`,
        value: path.basename(fileUri.fsPath),
    });
    if (!displayName) { return undefined; }

    const type = await pickWebResourceType(guessedType);
    if (!type) { return undefined; }

    const solution = await pickSolution(client);
    if (solution === undefined) { return undefined; }

    const id = await client.createWebResource({ name, displayName, type, contentBase64 });
    if (solution) {
        await client.addSolutionComponent(id, solution.uniqueName);
    }

    return id;
}

// ── File discovery ───────────────────────────────────────────────────────────

async function expandToFiles(uris: vscode.Uri[]): Promise<vscode.Uri[]> {
    const results: vscode.Uri[] = [];

    for (const uri of uris) {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
            const pattern = new vscode.RelativePattern(uri, `**/*.{${SUPPORTED_EXTENSIONS.join(',')}}`);
            results.push(...await vscode.workspace.findFiles(pattern));
        } else if (isSupportedExtension(uri.fsPath)) {
            results.push(uri);
        }
    }

    const unique = new Map(results.map(u => [u.fsPath, u]));
    return [...unique.values()];
}

async function findCandidateFiles(): Promise<vscode.Uri[]> {
    const results: vscode.Uri[] = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const rootFolder = getConfig(folder.uri).rootFolder;
        const pattern = new vscode.RelativePattern(folder, `${rootFolder}/**/*.{${SUPPORTED_EXTENSIONS.join(',')}}`);
        results.push(...await vscode.workspace.findFiles(pattern));
    }

    return results;
}

function isSupportedExtension(fsPath: string): boolean {
    return guessType(fsPath) !== undefined;
}

// ── Naming & type conventions ────────────────────────────────────────────────

function getConfig(scope: vscode.Uri): { rootFolder: string; namePrefix: string } {
    const config = vscode.workspace.getConfiguration('d365.webResources', scope);
    return {
        rootFolder: config.get<string>('rootFolder')?.trim() || 'webresources',
        namePrefix: normalizeNamePrefix(config.get<string>('namePrefix') ?? ''),
    };
}

// Ensures a non-empty prefix ends with '/' so it cleanly joins with the file's relative path.
function normalizeNamePrefix(prefix: string): string {
    const trimmed = prefix.trim();
    if (!trimmed) { return ''; }
    return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function toWebResourceName(fileUri: vscode.Uri): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(fileUri);
    if (!folder) { return undefined; }

    const { rootFolder, namePrefix } = getConfig(fileUri);
    const rootAbs = path.join(folder.uri.fsPath, rootFolder);
    const rel = path.relative(rootAbs, fileUri.fsPath);

    if (rel.startsWith('..') || path.isAbsolute(rel)) { return undefined; }
    return namePrefix + rel.split(path.sep).join('/');
}

function guessType(fsPath: string): number | undefined {
    const ext = path.extname(fsPath).slice(1).toLowerCase();
    return TYPE_BY_EXTENSION[ext];
}

// ── Prompts ──────────────────────────────────────────────────────────────────

async function pickWebResourceType(guessed: number): Promise<number | undefined> {
    const items = Object.entries(TYPE_LABELS).map(([value, label]) => ({
        label,
        description: Number(value) === guessed ? '(detected)' : undefined,
        type: Number(value),
    }));
    items.sort((a, b) => (a.type === guessed ? -1 : b.type === guessed ? 1 : 0));

    const pick = await vscode.window.showQuickPick(items, {
        title: 'D365: Web resource type',
        placeHolder: 'Confirm the web resource type',
    });
    return pick?.type;
}

// Returns the chosen solution, null for "don't add to a solution", or undefined if cancelled.
async function pickSolution(client: DataverseClient): Promise<Solution | null | undefined> {
    let solutions: Solution[];
    try {
        solutions = await client.getSolutions();
    } catch (err) {
        vscode.window.showWarningMessage(`D365: Could not load solutions (${errorMessage(err)}). Web resource will not be added to a solution.`);
        return null;
    }

    const NONE = { label: "Don't add to a solution", solution: null as Solution | null };
    const items = [
        NONE,
        ...solutions.map(s => ({ label: s.friendlyName, description: s.uniqueName, solution: s as Solution | null })),
    ];

    const pick = await vscode.window.showQuickPick(items, {
        title: 'D365: Add web resource to solution',
        placeHolder: 'Select a solution (optional)',
    });
    return pick?.solution;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

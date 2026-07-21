import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { DataverseClient, Publisher, RibbonLocationFilter, RibbonMetadataGenerationStatus } from './dataverseClient';
import { parseRibbonXml } from './ribbon/ribbonXmlParser';
import { buildRibbonDiffFragments, buildRibbonDiffXml, mergeRibbonDiffXml, resolveLabelsFromCache } from './ribbon/ribbonXmlBuilder';
import { resolveFluentIconDataUri } from './ribbon/fluentIcon';
import { buildRibbonSolutionZip, hasRibbonChanges } from './ribbon/solutionPackage';
import type { RibbonModel } from './ribbon/ribbonModel';
import type { RibbonLabelCache } from './ribbonLabelCache';
import { log, logError } from './logger';

const RIBBON_LOCATION_LABELS: Record<RibbonLocationFilter, string> = {
    All: 'All',
    Form: 'Main Form',
    HomepageGrid: 'Home Grid',
    SubGrid: 'Sub-Grid',
};

// A Ribbon Workbench-style viewer/editor for a single entity's ribbon, opened via the entity
// explorer's "Edit Ribbon…" context menu action or the `d365.editRibbon` command. Unlike
// EntityExplorerWebviewProvider (a sidebar WebviewView), this is a full editor-area WebviewPanel —
// this codebase's first use of `createWebviewPanel` — so it follows the same conventions
// (nonce-based CSP, post()/handleMessage()) but manages its own panel lifecycle.
//
// "Export RibbonDiffXml" opens the generated XML as a new, unsaved document for manual application.
// "Publish to Dynamics" (publishToDynamics below) instead applies it directly: a small throwaway
// unmanaged solution carrying just the ribbon diff is imported, the entity is published, and the
// temporary solution is removed. Note that removing that solution does NOT revert the ribbon change
// itself -- unmanaged solutions are just a labeled grouping over the org's one shared active layer,
// so once imported the change persists like any other unmanaged customization regardless of the
// transport solution's fate. "Temporary" only means no solution-list clutter is left behind.
export class RibbonEditorPanel {
    private static readonly panels = new Map<string, RibbonEditorPanel>();

    private readonly panel: vscode.WebviewPanel;
    private model: RibbonModel | undefined;

    // Caches resolved icon data URIs by ribbon image reference ($webresource:… or /_imgs/…).
    // `null` = looked up, none found (don't retry).
    private readonly _iconCache = new Map<string, string | null>();

    // Guards against a second "Publish to Dynamics" starting while one is already running for this
    // panel (there's no webview-side busy state disabling the button -- see publishToDynamics).
    private _publishing = false;

    // Same guard, for regenerateRibbonMetadata -- that operation affects the whole environment and
    // can run for many minutes, so it's especially worth not letting two overlap.
    private _regeneratingRibbonMetadata = false;

    static async createOrShow(
        extensionUri: vscode.Uri,
        client: DataverseClient,
        labelCache: RibbonLabelCache,
        entityLogicalName: string,
        entityDisplayName: string,
        ribbonLocation: RibbonLocationFilter,
    ): Promise<void> {
        // Each location is a materially different ribbon (different tabs/buttons), so it gets its
        // own panel rather than sharing one per entity.
        const key = `${entityLogicalName}:${ribbonLocation}`;
        const existing = RibbonEditorPanel.panels.get(key);
        if (existing) {
            log(`Ribbon editor: revealing existing panel for '${key}'`);
            existing.panel.reveal();
            return;
        }

        log(`Ribbon editor: opening new panel for '${key}'`);

        const publisherPrefix = await RibbonEditorPanel.resolvePublisherPrefix();

        const locationLabel = RIBBON_LOCATION_LABELS[ribbonLocation];
        const panel = vscode.window.createWebviewPanel(
            'd365.ribbonEditor',
            `Ribbon: ${entityDisplayName || entityLogicalName} (${locationLabel})`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'out', 'webview'),
                    vscode.Uri.joinPath(extensionUri, 'resources'),
                ],
            },
        );

        panel.iconPath = vscode.Uri.joinPath(extensionUri, 'resources', 'Ribbon.svg');

        const editor = new RibbonEditorPanel(panel, extensionUri, client, labelCache, entityLogicalName, entityDisplayName, ribbonLocation, publisherPrefix);
        RibbonEditorPanel.panels.set(key, editor);
        panel.onDidDispose(() => RibbonEditorPanel.panels.delete(key));

        await editor.loadRibbon();
    }

    // Ids for anything created in the ribbon editor are built as {prefix}.{entity}.{name}.{kind} (see
    // buildRibbonElementId in the webview, ribbonState.ts) -- a real Dataverse customization prefix,
    // same as any other unmanaged customization would use, rather than this tool's own throwaway
    // "new_"-style ids. Prompted once per workspace and saved to workspace settings; every later
    // panel (any entity, this session or a future one) just reads the saved value silently.
    private static async resolvePublisherPrefix(): Promise<string> {
        const config = vscode.workspace.getConfiguration('d365.ribbonEditor');
        const saved = config.get<string>('publisherPrefix');
        if (saved) { return saved; }

        const entered = await vscode.window.showInputBox({
            title: 'D365: Publisher Prefix for Ribbon Customizations',
            prompt: 'Used to build ids for anything you add in the ribbon editor, e.g. "new" → new.account.myaction.button. Saved for this workspace.',
            placeHolder: 'e.g. new, tn, contoso',
            validateInput: value => {
                const trimmed = value.trim();
                if (!trimmed) { return 'A publisher prefix is required to add new ribbon elements.'; }
                if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(trimmed)) { return 'Use letters and numbers only, starting with a letter.'; }
                return undefined;
            },
        });
        if (!entered) { return ''; }

        const prefix = entered.trim();
        await config.update('publisherPrefix', prefix, vscode.ConfigurationTarget.Workspace);
        return prefix;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly client: DataverseClient,
        private readonly labelCache: RibbonLabelCache,
        private readonly entityLogicalName: string,
        private readonly entityDisplayName: string,
        private readonly ribbonLocation: RibbonLocationFilter,
        private readonly publisherPrefix: string,
    ) {
        this.panel = panel;
        panel.webview.html = buildHtml(panel.webview, extensionUri);
        panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
            try {
                await this.handleMessage(msg);
            } catch (err) {
                logError(`ribbon editor ('${this.entityLogicalName}') handling '${String(msg.type)}'`, err);
                vscode.window.showErrorMessage(`D365 ribbon editor error: ${errMsg(err)}`);
            }
        });
    }

    private async handleMessage(msg: Record<string, unknown>): Promise<void> {
        // Request/response RPC (icon fetching) — see resolveRequest.
        if (msg.kind === 'request') {
            await this.handleRequest(msg as { id: number; op: string; params: Record<string, unknown> });
            return;
        }

        log(`Ribbon editor ('${this.entityLogicalName}'): received '${String(msg.type)}'`);
        switch (msg.type) {
            case 'ready':
                if (this.model) { this.postModel(); }
                break;
            case 'reloadFromServer':
                await this.loadRibbon();
                break;
            case 'exportRibbonDiffXml':
                await this.exportRibbonDiffXml(msg.model as RibbonModel);
                break;
            case 'publishToDynamics':
                await this.publishToDynamics(msg.model as RibbonModel);
                break;
            case 'regenerateRibbonMetadata':
                await this.regenerateRibbonMetadata();
                break;
        }
    }

    // ── RPC (request/response) ──────────────────────────────────────────────
    // The webview posts { kind: 'request', id, op, params } and awaits a matching
    // { kind: 'response', id, ok, data|error } — same shape as EntityExplorerWebviewProvider's.

    private async handleRequest(req: { id: number; op: string; params: Record<string, unknown> }): Promise<void> {
        try {
            const data = await this.resolveRequest(req.op, req.params);
            this.post({ kind: 'response', id: req.id, ok: true, data });
        } catch (err) {
            this.post({ kind: 'response', id: req.id, ok: false, error: errMsg(err) });
        }
    }

    private resolveRequest(op: string, params: Record<string, unknown>): Promise<unknown> {
        switch (op) {
            case 'getIcon':
                return this.getIconContent(params.ref as string, !!params.isModern);
            case 'searchWebResources':
                return this.client.searchWebResources(params.query as string);
            default:
                throw new Error(`Unknown request op: ${op}`);
        }
    }

    private async getIconContent(ref: string, isModern: boolean): Promise<string | null> {
        if (!ref) { return null; }
        const cacheKey = isModern ? `modern:${ref}` : ref;
        if (this._iconCache.has(cacheKey)) { return this._iconCache.get(cacheKey) ?? null; }

        let content: string | undefined;
        try {
            content = await this.client.getRibbonImageContent(ref);
        } catch (err) {
            logError(`ribbon editor ('${this.entityLogicalName}') getIconContent('${ref}')`, err);
            content = undefined; // fall through and cache null
        }

        // A bare ModernImage name (not an explicit $webresource:/system-path reference) that the web
        // resource lookup above didn't resolve is most likely one of Dataverse's built-in Fluent icon
        // names -- see fluentIcon.ts.
        if (!content && isModern && !ref.startsWith('$webresource:') && !ref.startsWith('/')) {
            content = resolveFluentIconDataUri(ref);
        }

        if (!content) {
            log(`Ribbon editor ('${this.entityLogicalName}'): icon ref '${ref}' (isModern=${isModern}) did not resolve to any web resource or built-in icon`);
        }

        this._iconCache.set(cacheKey, content ?? null);
        return content ?? null;
    }

    private async loadRibbon(): Promise<void> {
        log(`Ribbon editor ('${this.entityLogicalName}'): loading '${this.ribbonLocation}' ribbon XML…`);
        this.post({ type: 'ribbonLoading' });

        // A `null` (not-found) icon lookup is only ever cached for the panel's whole lifetime, which
        // can span many publishes -- a web resource created or published after the *first* time its
        // icon was looked up (a very normal order of operations: reference it in the ribbon, then
        // upload/publish the actual file) would otherwise show as missing here forever, even after it
        // renders correctly in Dynamics itself. A real reload is the natural moment to give those
        // another chance; a successful lookup is left alone (still safe to trust, and free to reuse).
        for (const [key, value] of this._iconCache) {
            if (value === null) { this._iconCache.delete(key); }
        }
        try {
            const xml = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `D365: Loading ribbon for '${this.entityLogicalName}'…`, cancellable: false },
                () => this.client.getEntityRibbonXml(this.entityLogicalName, this.ribbonLocation),
            );
            log(`Ribbon editor ('${this.entityLogicalName}'): received ${xml.length} chars of ribbon XML, parsing…`);
            this.model = parseRibbonXml(xml);
            log(`Ribbon editor ('${this.entityLogicalName}'): parsed ${this.model.tabs.length} tab(s), ${this.model.commandDefinitions.length} command definition(s), ${this.model.enableRules.length} enable rule(s), ${this.model.displayRules.length} display rule(s)`);

            // RetrieveEntityRibbon's own LocLabels dictionary doesn't reliably resolve a custom
            // $LocLabels: reference back to its real text (confirmed even right after a full ribbon
            // metadata regeneration), even though the label displays correctly in the actual running
            // app -- fall back to whatever this tool itself last published for that Id, if anything.
            const environmentUrl = this.client.environmentUrl;
            if (environmentUrl) { resolveLabelsFromCache(this.model, this.labelCache.get(environmentUrl)); }

            this.postModel();
        } catch (err) {
            logError(`ribbon editor ('${this.entityLogicalName}') loadRibbon`, err);
            this.post({ type: 'ribbonError', message: errMsg(err) });
        }
    }

    private postModel(): void {
        this.post({
            type: 'ribbonModel',
            entityLogicalName: this.entityLogicalName,
            entityDisplayName: this.entityDisplayName,
            ribbonLocationLabel: RIBBON_LOCATION_LABELS[this.ribbonLocation],
            publisherPrefix: this.publisherPrefix,
            model: this.model,
        });
    }

    private async exportRibbonDiffXml(model: RibbonModel): Promise<void> {
        const xml = buildRibbonDiffXml(model);
        log(`Ribbon editor ('${this.entityLogicalName}'): exported RibbonDiffXml (${xml.length} chars)`);
        const doc = await vscode.workspace.openTextDocument({ content: xml, language: 'xml' });
        await vscode.window.showTextDocument(doc, { preview: false });
    }

    private async publishToDynamics(model: RibbonModel): Promise<void> {
        if (this._publishing) {
            vscode.window.showWarningMessage('D365: A publish to Dynamics is already in progress for this ribbon.');
            return;
        }

        if (!hasRibbonChanges(model)) {
            vscode.window.showInformationMessage('D365: No ribbon changes to publish.');
            return;
        }

        const entityLabel = this.entityDisplayName || this.entityLogicalName;
        const confirmed = await vscode.window.showWarningMessage(
            `Publish ribbon changes to '${entityLabel}' on the connected environment? This imports a ` +
            `temporary solution to apply the changes, publishes them, then removes the temporary ` +
            `solution. The ribbon change itself is not automatically undoable afterward.`,
            { modal: true },
            'Publish',
        );
        if (confirmed !== 'Publish') { return; }

        const publisher = await pickPublisher(this.client);
        if (!publisher) { return; }

        this._publishing = true;
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `D365: Publishing ribbon changes to '${entityLabel}'…`, cancellable: false },
                progress => this.runPublish(model, publisher, entityLabel, progress),
            );
        } finally {
            this._publishing = false;
        }
    }

    private async runPublish(
        model: RibbonModel,
        publisher: Publisher,
        entityLabel: string,
        progress: vscode.Progress<{ message?: string }>,
    ): Promise<void> {
        progress.report({ message: 'Reading entity metadata…' });
        const entityMetadata = await this.client.getEntityRibbonMetadata(this.entityLogicalName);

        progress.report({ message: 'Reading existing ribbon customization…' });
        let existingRibbonDiffXml: string | undefined;
        try {
            existingRibbonDiffXml = await this.client.getEntityCurrentRibbonDiffXml(
                this.entityLogicalName, entityMetadata.metadataId, publisher.publisherId,
            );
        } catch (err) {
            logError(`ribbon editor ('${this.entityLogicalName}') getEntityCurrentRibbonDiffXml`, err);
            const proceed = await vscode.window.showWarningMessage(
                `D365: Could not read the existing ribbon customizations for '${entityLabel}' (${errMsg(err)}). Publishing anyway ` +
                `would replace ALL of its existing ribbon customizations with only this session's changes, discarding ` +
                `anything else customized previously (by this tool, Ribbon Workbench, or by hand). Continue anyway?`,
                { modal: true },
                'Publish Anyway',
            );
            if (proceed !== 'Publish Anyway') { return; }
        }

        // Merges this session's edits into the entity's actual existing diff rather than rebuilding
        // one purely from this model -- see mergeRibbonDiffXml's own doc comment for why that matters.
        const ribbonDiffXml = mergeRibbonDiffXml(existingRibbonDiffXml ?? '', model);
        const solutionUniqueName = `d365vscodetools_ribbon_${Date.now()}`;
        const zip = buildRibbonSolutionZip({
            entityLogicalName: this.entityLogicalName,
            entityDisplayName: this.entityDisplayName,
            entityMetadata,
            ribbonDiffXml,
            publisherUniqueName: publisher.uniqueName,
            solutionUniqueName,
            solutionFriendlyName: `Ribbon changes: ${entityLabel} (temporary)`,
        });

        progress.report({ message: 'Importing temporary solution…' });
        const importJobId = randomUUID();
        log(`Ribbon editor ('${this.entityLogicalName}'): importing temporary solution '${solutionUniqueName}' (job ${importJobId})`);
        try {
            await this.client.importSolution(zip.toString('base64'), importJobId);
        } catch (err) {
            logError(`ribbon editor ('${this.entityLogicalName}') importSolution`, err);
            vscode.window.showErrorMessage(`D365: Publish failed while importing the temporary solution: ${errMsg(err)}`);
            return;
        }

        const result = await waitForImportJob(this.client, importJobId);
        if (!result.success) {
            log(`Ribbon editor ('${this.entityLogicalName}'): import job ${importJobId} did not succeed: ${result.errorText}`);
            vscode.window.showErrorMessage(
                `D365: Publish failed: ${result.errorText ?? 'the import did not complete.'} ` +
                `The temporary solution '${solutionUniqueName}' was left in place for inspection.`,
            );
            return;
        }
        if (result.warningText) {
            log(`Ribbon editor ('${this.entityLogicalName}'): import job ${importJobId} succeeded with a warning: ${result.warningText}`);
        }

        // The solution record itself (found by unique name) is what gets published/deleted below --
        // ImportSolution doesn't return its id directly.
        const solutions = await this.client.getSolutions().catch(() => []);
        const importedSolution = solutions.find(s => s.uniqueName === solutionUniqueName);

        progress.report({ message: 'Publishing…' });
        try {
            await this.client.publishEntity(this.entityLogicalName);
        } catch (err) {
            logError(`ribbon editor ('${this.entityLogicalName}') publishEntity`, err);
            vscode.window.showWarningMessage(
                `D365: The ribbon change was imported but publishing failed (${errMsg(err)}), so it may not be visible yet. ` +
                `You may need to publish '${entityLabel}' manually.`,
            );
            if (importedSolution) { await this.client.deleteSolution(importedSolution.solutionId).catch(() => undefined); }
            return;
        }

        // Remember what each $LocLabels: reference just published actually says, since re-reading it
        // back from RetrieveEntityRibbon isn't reliable -- see loadRibbon and RibbonLabelCache.
        const environmentUrl = this.client.environmentUrl;
        if (environmentUrl) { await this.labelCache.merge(environmentUrl, buildRibbonDiffFragments(model).resolvedLabels); }

        progress.report({ message: 'Cleaning up…' });
        if (importedSolution) {
            try {
                await this.client.deleteSolution(importedSolution.solutionId);
            } catch (err) {
                logError(`ribbon editor ('${this.entityLogicalName}') deleteSolution`, err);
                vscode.window.showWarningMessage(
                    `D365: Ribbon changes were published, but the temporary solution '${solutionUniqueName}' could not be ` +
                    `automatically removed. You may want to delete it manually.`,
                );
            }
        } else {
            vscode.window.showWarningMessage(
                `D365: Ribbon changes were published, but the temporary solution '${solutionUniqueName}' could not be found ` +
                `afterward to remove it. You may want to delete it manually.`,
            );
        }

        // Deliberately NOT an automatic reload: this session's edits just got serialized through
        // $LocLabels: references (see ribbonXmlBuilder.ts), and Dataverse's ribbon metadata cache
        // doesn't reliably resolve a brand-new LocLabel back to real text immediately after import --
        // reloading right away could show a freshly-published label as an unresolved reference (with
        // NodeEditor's "showing a guess" hint) even though the publish itself succeeded. Offering a
        // manual reload button instead lets the user pick the moment (their own "Reload" toolbar
        // action does the same thing), by which point the cache has more likely caught up.
        const message = result.warningText
            ? `D365: Ribbon changes published to '${entityLabel}', with a non-fatal warning from Dataverse: ${result.warningText}`
            : `D365: Ribbon changes published to '${entityLabel}'.`;
        vscode.window.showInformationMessage(message, 'Reload').then(choice => {
            if (choice === 'Reload') { void this.loadRibbon(); }
        });
    }

    // RegenerateRibbonMetadataForAllEntities (see dataverseClient.ts) always regenerates for the
    // whole environment -- there is no way to scope it to just this entity -- and can take 15+
    // minutes running as a background server-side job. Confirmed by capturing Command Checker's own
    // "Regenerate ribbon metadata" button's network request: this is the exact same call.
    //
    // Tracked the same way Solutions History tracks it in the maker portal -- via Solution History
    // (getLatestRibbonMetadataGenerationRun), NOT the per-entity queue table an earlier version of
    // this method tried and gave up on after a live 404 confirmed it isn't reachable. If Solution
    // History itself turns out to be unreachable in some environment too, waitForRibbonMetadataGeneration
    // degrades to just pointing the user at Solutions History manually rather than erroring.
    private async regenerateRibbonMetadata(): Promise<void> {
        if (this._regeneratingRibbonMetadata) {
            vscode.window.showWarningMessage('D365: A ribbon metadata regeneration is already in progress.');
            return;
        }

        const confirmed = await vscode.window.showWarningMessage(
            `Regenerate ribbon metadata for the connected environment? This affects ALL tables, not just ` +
            `'${this.entityLogicalName}' -- it's the same operation as Command Checker's "Regenerate ribbon ` +
            `metadata" button, and can take 15 minutes or longer running in the background.`,
            { modal: true },
            'Regenerate',
        );
        if (confirmed !== 'Regenerate') { return; }

        this._regeneratingRibbonMetadata = true;
        try {
            // A few seconds of slack for clock skew between this machine and Dataverse, so we don't
            // miss the row this run creates by filtering it out as "before we started".
            const sinceUtc = new Date(Date.now() - 5_000);
            await this.client.regenerateAllRibbonMetadata();
            log(`Ribbon editor ('${this.entityLogicalName}'): triggered RegenerateRibbonMetadataForAllEntities`);

            const outcome = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'D365: Regenerating ribbon metadata for the environment…', cancellable: true },
                (progress, token) => waitForRibbonMetadataGeneration(this.client, sinceUtc, progress, token),
            );

            if (outcome.outcome === 'success') {
                vscode.window.showInformationMessage('D365: Ribbon metadata regeneration completed successfully.');
            } else if (outcome.outcome === 'failure') {
                vscode.window.showErrorMessage(
                    `D365: Ribbon metadata regeneration failed${outcome.exceptionMessage ? `: ${outcome.exceptionMessage}` : '.'}`,
                );
            } else {
                vscode.window.showInformationMessage(
                    'D365: Ribbon metadata regeneration started for the environment, but its progress could not be tracked ' +
                    'from here. Check Settings > Solutions > Solutions History in the maker portal for its status.',
                );
            }
        } catch (err) {
            logError(`ribbon editor ('${this.entityLogicalName}') regenerateAllRibbonMetadata`, err);
            vscode.window.showErrorMessage(`D365: Failed to start ribbon metadata regeneration: ${errMsg(err)}`);
        } finally {
            this._regeneratingRibbonMetadata = false;
        }
    }

    private post(message: unknown): void {
        void this.panel.webview.postMessage(message);
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// Solution.xml's <Publisher> only needs an existing publisher's unique name (see solutionPackage.ts),
// so this just needs *a* real one -- skip the prompt when there's only one to choose from, mirroring
// pickSolution's shape in webResourceManager.ts.
async function pickPublisher(client: DataverseClient): Promise<Publisher | undefined> {
    let publishers: Publisher[];
    try {
        publishers = await client.getPublishers();
    } catch (err) {
        vscode.window.showErrorMessage(`D365: Could not load publishers (${errMsg(err)}).`);
        return undefined;
    }

    if (publishers.length === 0) {
        vscode.window.showErrorMessage('D365: No publisher is available in this environment to own the temporary solution.');
        return undefined;
    }
    if (publishers.length === 1) { return publishers[0]; }

    const pick = await vscode.window.showQuickPick(
        publishers.map(p => ({ label: p.friendlyName, description: p.uniqueName, publisher: p })),
        { title: 'D365: Publisher for the temporary solution', placeHolder: 'Select a publisher…' },
    );
    return pick?.publisher;
}

// ImportSolution completes synchronously from the caller's perspective, but the ImportJob record's
// own `data` column is the documented way to confirm success/failure -- poll briefly in case it
// hasn't been written the instant the action call returns.
async function waitForImportJob(client: DataverseClient, importJobId: string, timeoutMs = 60_000, intervalMs = 1_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const result = await client.getImportJobResult(importJobId);
        if (result.completed) { return result; }
        await delay(intervalMs);
    }
    return { completed: false, success: false, errorText: 'Timed out waiting for the import to complete.' };
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

type RibbonMetadataGenerationOutcome =
    | { outcome: 'success' }
    | { outcome: 'failure'; exceptionMessage?: string }
    // Cancelled, timed out, or Solution History itself wasn't reachable -- in every case the
    // operation may still be running server-side, this extension just can't say more about it.
    | { outcome: 'unknown' };

// Polls Solution History (getLatestRibbonMetadataGenerationRun) for the row this run's
// regenerateAllRibbonMetadata call created, identified by starting after `sinceUtc`.
async function waitForRibbonMetadataGeneration(
    client: DataverseClient,
    sinceUtc: Date,
    progress: vscode.Progress<{ message?: string }>,
    token: vscode.CancellationToken,
    timeoutMs = 30 * 60_000,
    intervalMs = 5_000,
): Promise<RibbonMetadataGenerationOutcome> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (token.isCancellationRequested) { return { outcome: 'unknown' }; }

        let status: RibbonMetadataGenerationStatus | undefined;
        try {
            status = await client.getLatestRibbonMetadataGenerationRun(sinceUtc);
        } catch (err) {
            // Mirrors the confirmed-404 per-entity queue table -- if Solution History itself isn't
            // reachable in this environment either, stop polling rather than hammering a broken
            // endpoint for up to 30 minutes.
            logError('ribbon editor regenerateRibbonMetadata: could not read Solution History', err);
            return { outcome: 'unknown' };
        }

        if (status?.status === 'Completed') {
            return status.result === 'Failure'
                ? { outcome: 'failure', exceptionMessage: status.exceptionMessage }
                : { outcome: 'success' };
        }

        const elapsedMin = Math.round((Date.now() - start) / 60_000);
        progress.report({
            message: status
                ? `${status.status}… (${elapsedMin}m elapsed)`
                : `Waiting for the operation to be recorded… (${elapsedMin}m elapsed)`,
        });
        await delay(intervalMs);
    }
    return { outcome: 'unknown' };
}

// ── HTML shell ───────────────────────────────────────────────────────────────
// Same shape as entityExplorerWebview.ts's buildHtml — loads the esbuild-bundled React app for
// this panel (out/webview/ribbonEditor.{js,css}) through a locked-down, nonce-based CSP.

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'ribbonEditor.js'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'ribbonEditor.css'));

    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} data:`,
        `font-src ${webview.cspSource} data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${styleUri}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function makeNonce(): string {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

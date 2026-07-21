import * as vscode from 'vscode';

const GLOBAL_STATE_KEY = 'd365.ribbonEditor.resolvedLabels';

// Remembers the literal text behind a ribbon $LocLabels: reference this tool itself most recently
// published, keyed by environment then LocLabel Id -- RetrieveEntityRibbon's own LocLabels dictionary
// doesn't reliably resolve a custom entry back to real text (confirmed even right after a full ribbon
// metadata regeneration), even though the label displays correctly in the actual running app. See
// ribbonXmlBuilder.ts's resolveLabelsFromCache for how this gets consulted on load, and
// buildRibbonDiffFragments' resolvedLabels for where the text originally comes from (at publish time).
// globalState (not workspaceState) since this is a property of the environment/org, not of any one
// workspace -- same reasoning as EntityCache.
export class RibbonLabelCache {
    constructor(private readonly context: vscode.ExtensionContext) {}

    get(environmentUrl: string): Record<string, string> {
        const byEnvironment = this.context.globalState.get<Record<string, Record<string, string>>>(GLOBAL_STATE_KEY, {});
        return byEnvironment[environmentUrl] ?? {};
    }

    async merge(environmentUrl: string, labels: Record<string, string>): Promise<void> {
        if (!Object.keys(labels).length) { return; }
        const byEnvironment = { ...this.context.globalState.get<Record<string, Record<string, string>>>(GLOBAL_STATE_KEY, {}) };
        byEnvironment[environmentUrl] = { ...byEnvironment[environmentUrl], ...labels };
        await this.context.globalState.update(GLOBAL_STATE_KEY, byEnvironment);
    }
}

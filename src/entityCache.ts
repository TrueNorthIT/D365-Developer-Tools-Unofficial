import * as vscode from 'vscode';
import type { EntityDefinition } from './dataverseClient';

interface CacheEntry {
    fetchedAt: number;
    entities: EntityDefinition[];
}

const GLOBAL_STATE_KEY = 'd365.entityCache';

// Caches the entity metadata list per environment in globalState (not workspaceState -- the entity
// list is a property of the org, not of any one workspace, so it should survive across workspaces
// pointed at the same environment too). Lets the Entity Explorer render instantly from a prior
// fetch while a fresh one runs in the background -- see EntityExplorerWebviewProvider.sendEntities.
export class EntityCache {
    constructor(private readonly context: vscode.ExtensionContext) {}

    get(environmentUrl: string): EntityDefinition[] | undefined {
        const byEnvironment = this.context.globalState.get<Record<string, CacheEntry>>(GLOBAL_STATE_KEY, {});
        return byEnvironment[environmentUrl]?.entities;
    }

    async set(environmentUrl: string, entities: EntityDefinition[]): Promise<void> {
        const byEnvironment = { ...this.context.globalState.get<Record<string, CacheEntry>>(GLOBAL_STATE_KEY, {}) };
        byEnvironment[environmentUrl] = { fetchedAt: Date.now(), entities };
        await this.context.globalState.update(GLOBAL_STATE_KEY, byEnvironment);
    }
}

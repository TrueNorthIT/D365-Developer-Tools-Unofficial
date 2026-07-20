import * as vscode from 'vscode';
import type { EntityDefinition } from './dataverseClient';

interface CacheEntry {
    fetchedAt: number;
    entities: EntityDefinition[];
}

const GLOBAL_STATE_KEY = 'd365.entityCache';

interface SolutionEntityIdsCacheEntry {
    fetchedAt: number;
    entityIds: string[];
}

const SOLUTION_ENTITY_IDS_GLOBAL_STATE_KEY = 'd365.solutionEntityIdsCache';

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

    // Same cache-first idea as get/set above, but for a solution's member entity ids -- the other
    // live fetch (getSolutionEntityIds) that otherwise made the default-solution filter lag behind
    // the (already-cached) entity list on every reload. Keyed by environment + solution, since the
    // same solutionId is meaningless across different environments.
    getSolutionEntityIds(environmentUrl: string, solutionId: string): string[] | undefined {
        const byKey = this.context.globalState.get<Record<string, SolutionEntityIdsCacheEntry>>(SOLUTION_ENTITY_IDS_GLOBAL_STATE_KEY, {});
        return byKey[solutionCacheKey(environmentUrl, solutionId)]?.entityIds;
    }

    async setSolutionEntityIds(environmentUrl: string, solutionId: string, entityIds: string[]): Promise<void> {
        const byKey = { ...this.context.globalState.get<Record<string, SolutionEntityIdsCacheEntry>>(SOLUTION_ENTITY_IDS_GLOBAL_STATE_KEY, {}) };
        byKey[solutionCacheKey(environmentUrl, solutionId)] = { fetchedAt: Date.now(), entityIds };
        await this.context.globalState.update(SOLUTION_ENTITY_IDS_GLOBAL_STATE_KEY, byKey);
    }
}

function solutionCacheKey(environmentUrl: string, solutionId: string): string {
    return `${environmentUrl}::${solutionId}`;
}

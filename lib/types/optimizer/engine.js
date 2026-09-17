import { snapshotCatalog, describeTool, buildCatalogView } from "./catalog.js";
import { FORCED_EAGER } from "./groups.js";
import { BRIDGE_NAMES } from "./bridge.js";
import { keywordSearch, searchCatalog } from "./matcher.js";
import { applyDisclosure, budgetFor, computeDisclosure, computeTier } from "./disclosure.js";
import { estimateTokens } from "./catalog.js";
import { buildGroupedManifest } from "./groups.js";
import { validateGroups } from "./groups.js";
function schemaTokens(entries) {
    return entries.reduce((total, entry) => total + estimateTokens(JSON.stringify({
        name: entry.name,
        description: entry.description,
        parameters: entry.parameters,
    })), 0);
}
/** Extract the last non-empty user text from a session, or `''` when none. */
function lastUserText(session) {
    const derive = session.deriveMessages;
    if (derive === undefined)
        return '';
    const messages = derive.call(session);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (message?.role !== 'user')
            continue;
        const content = message.content;
        if (!Array.isArray(content))
            continue;
        for (let j = content.length - 1; j >= 0; j -= 1) {
            const block = content[j];
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
                return block.text;
            }
        }
    }
    return '';
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/** The agent behind a scope key, when the runtime supplied one. */
function agentOf(scope) {
    if (scope === undefined || scope === null)
        return undefined;
    const candidate = scope;
    return candidate.session !== undefined ? scope : undefined;
}
/** The session workspace of an agent, when the session carries one. */
function cwdOf(agent) {
    return agent?.session.header.cwd;
}
/**
 * The context optimizer engine resolves runtime config, computes the slimmed
 * model-visible tool surface per assembly, serves the bridge and setup tools,
 * and maintains the per-session warm set that dynamically injects discovered
 * tools back into the visible context. One instance per plugin load.
 */
export class ToolSearchEngine {
    ctx;
    config;
    store;
    /** Session id → tool name → last-use sequence (warm set, LRU-bounded). */
    warm = new Map();
    /** Sessions whose preload already ran. */
    preloadedSessions = new Set();
    warmSeq = 0;
    constructor(ctx, config, store) {
        this.ctx = ctx;
        this.config = config;
        this.store = store;
    }
    /**
     * Transform one settled assembly: replace `assembly.tools` with the eager
     * core, bridge tools, and warm tools, and append the tiered manifest as a
     * runtime context (sections may be clobbered by a complete prompt; contexts
     * survive). Tier 0 returns the assembly untouched. Idempotent: the catalog
     * is re-read from the registry on every call.
     * @param assembly - the settled assembly from the waterfall chain.
     * @param scope - the calling agent (or undefined for the global view).
     * @returns the transformed assembly.
     */
    async assemble(assembly, scope) {
        const agent = agentOf(scope);
        const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent));
        const groups = runtime.config.groups ?? [];
        const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), groups);
        const eager = await this.eagerNames(agent, entries, runtime.config);
        const deferred = entries.filter(entry => !eager.has(entry.name));
        if (deferred.length === 0)
            return assembly;
        const forced = this.config.enabled === 'on';
        if (!forced && entries.length <= this.config.minCatalogSize)
            return assembly;
        const budget = budgetFor(this.config.thresholdPct, this.config.contextWindow, this.config.listingMaxTokens);
        const tier = computeTier({
            catalogSize: entries.length,
            deferredSize: deferred.length,
            manifestTokens: estimateTokens(buildGroupedManifest(deferred, 'full')),
            namesOnlyTokens: estimateTokens(buildGroupedManifest(deferred, 'names')),
            budget,
            minCatalogSize: this.config.minCatalogSize,
            forced,
        });
        const disclosure = computeDisclosure(entries, eager, new Set(BRIDGE_NAMES), tier);
        return applyDisclosure(assembly, disclosure);
    }
    /**
     * Inspect the registered and effective model-visible tool surfaces for one
     * session. The result uses the exact disclosure calculation used by
     * `assemble()`, making optimisation savings observable to the audit layer.
     */
    async analyzeSurface(scope) {
        const agent = agentOf(scope);
        const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent));
        const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), runtime.config.groups ?? []);
        const eager = await this.eagerNames(agent, entries, runtime.config);
        const deferred = entries.filter(entry => !eager.has(entry.name));
        const forced = this.config.enabled === 'on';
        const active = this.config.enabled !== 'off' && deferred.length > 0
            && (forced || entries.length > this.config.minCatalogSize);
        const budget = budgetFor(this.config.thresholdPct, this.config.contextWindow, this.config.listingMaxTokens);
        const tier = active ? computeTier({
            catalogSize: entries.length,
            deferredSize: deferred.length,
            manifestTokens: estimateTokens(buildGroupedManifest(deferred, 'full')),
            namesOnlyTokens: estimateTokens(buildGroupedManifest(deferred, 'names')),
            budget,
            minCatalogSize: this.config.minCatalogSize,
            forced,
        }) : 0;
        const disclosure = computeDisclosure(entries, eager, new Set(BRIDGE_NAMES), tier);
        const registeredSchemaTokens = schemaTokens(entries);
        const visibleSchemaTokens = schemaTokens(snapshotCatalog(disclosure.tools, []));
        const manifestTokens = estimateTokens(disclosure.manifest);
        return {
            active: tier !== 0,
            tier,
            registeredTools: entries.length,
            registeredSchemaTokens,
            visibleTools: disclosure.tools.length,
            visibleSchemaTokens,
            deferredTools: deferred.length,
            manifestTokens,
            savedTokens: Math.max(0, registeredSchemaTokens - visibleSchemaTokens - manifestTokens),
            warmTools: this.warmNamesFor(agent),
        };
    }
    /**
     * Search the deferred catalog. Uses the configured rerank matcher when
     * present; falls back to keyword matching when absent or on rerank failure,
     * so `tool_search` never dead-ends. Also warms the matched tools into the
     * session's visible set (dynamic injection).
     * @param query - the model's search query.
     * @param limit - requested result count (clamped to config bounds).
     * @param scope - the calling agent.
     * @returns matches plus the ranking mode used.
     */
    async search(query, limit, scope) {
        const agent = agentOf(scope);
        const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent));
        const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), runtime.config.groups ?? []);
        const eager = await this.eagerNames(agent, entries, runtime.config);
        const deferred = entries.filter(entry => !eager.has(entry.name));
        const bounded = Math.min(Math.max(limit ?? this.config.searchDefaultLimit, 1), this.config.maxSearchLimit);
        const matcher = runtime.config.matcher;
        if (matcher === undefined) {
            const matches = keywordSearch(query, deferred, bounded);
            this.warmTools(agent, matches.map(match => match.name));
            return {
                matches,
                mode: 'keyword',
                hint: 'no rerank matcher configured: run the tool-slimmer-setup skill to configure one for semantic ranking',
            };
        }
        try {
            const matches = await searchCatalog(matcher, query, deferred, bounded, this.config.matcherTimeoutMs);
            this.warmTools(agent, matches.map(match => match.name));
            return { matches, mode: 'rerank' };
        }
        catch (error) {
            this.ctx.logger.warn(`dsh-context-optimizer: rerank failed, falling back to keyword matching: ${errorMessage(error)}`);
            const matches = keywordSearch(query, deferred, bounded);
            this.warmTools(agent, matches.map(match => match.name));
            return {
                matches,
                mode: 'keyword',
                hint: `rerank failed (${errorMessage(error)}); fell back to keyword matching`,
            };
        }
    }
    /**
     * Resolve the full schema of one catalog tool and warm it into the session.
     * @param name - the tool name.
     * @param scope - the calling agent.
     * @returns the model-facing schema fields, or `undefined` when unknown.
     */
    describe(name, scope) {
        const agent = agentOf(scope);
        const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), []);
        const schema = describeTool(entries, name);
        if (schema !== undefined)
            this.warmTools(agent, [name]);
        return schema;
    }
    /** The grouped catalog view the setup skill reads to propose grouping. */
    async catalogView(scope) {
        const agent = agentOf(scope);
        const runtime = await this.store.resolve(this.config.configScope, cwdOf(agent));
        const entries = snapshotCatalog(this.ctx.tools.schemas(agent ?? undefined), runtime.config.groups ?? []);
        const eager = await this.eagerNames(agent, entries, runtime.config);
        const deferredNames = new Set(entries.filter(entry => !eager.has(entry.name)).map(entry => entry.name));
        return buildCatalogView(entries, deferredNames);
    }
    /**
     * Validate and persist a runtime config update, then drop stale caches.
     * @param input - groups/matcher/preload/core changes and the target scope.
     * @param scope - the calling agent (drives the default scope and workspace).
     * @returns the written path, effective scope, and a summary for the model.
     */
    async updateConfig(input, scope) {
        const agent = agentOf(scope);
        const current = await this.store.resolve(this.config.configScope, cwdOf(agent));
        const target = input.scope ?? current.scope;
        if (input.groups !== undefined) {
            const reason = validateGroups(input.groups);
            if (reason !== undefined)
                throw new Error(`invalid groups: ${reason}`);
        }
        const next = {
            ...current.config,
            ...input.groups !== undefined ? { groups: input.groups } : {},
            ...input.matcher !== undefined ? { matcher: input.matcher } : {},
            ...input.preload !== undefined ? { preload: input.preload } : {},
            ...input.core !== undefined ? { core: input.core } : {},
        };
        const path = await this.store.write(target, cwdOf(agent), next);
        this.warm.clear();
        this.preloadedSessions.clear();
        return {
            path,
            scope: target,
            groups: (next.groups ?? []).map(group => ({ name: group.name, tools: [...(group.tools ?? []), ...(group.prefixes ?? [])] })),
            matcherConfigured: next.matcher !== undefined,
            preloadEnabled: next.preload?.enabled === true,
        };
    }
    /**
     * Add tools to a session's warm set, LRU-bounded by `maxWarmTools`. Warm
     * tools are injected into the visible context on subsequent assemblies.
     * @param agent - the owning agent (warmth is per session).
     * @param names - tool names to warm.
     */
    warmTools(agent, names) {
        const session = agent?.session;
        if (session === undefined || names.length === 0)
            return;
        let set = this.warm.get(session.id);
        if (set === undefined) {
            set = new Map();
            this.warm.set(session.id, set);
        }
        for (const name of names) {
            set.set(name, ++this.warmSeq);
        }
        while (set.size > this.config.maxWarmTools) {
            let oldest;
            let oldestSeq = Number.POSITIVE_INFINITY;
            for (const [name, seq] of set) {
                if (seq < oldestSeq) {
                    oldestSeq = seq;
                    oldest = name;
                }
            }
            if (oldest === undefined)
                break;
            set.delete(oldest);
        }
    }
    /** The names of a session's warm tools, in warm order (oldest first). */
    warmNamesFor(agent) {
        if (agent === undefined)
            return [];
        return [...(this.warm.get(agent.session.id) ?? new Map()).keys()];
    }
    async eagerNames(agent, entries, runtime) {
        const preload = await this.preloadNames(agent, entries, runtime);
        return new Set([...this.config.core, ...(runtime.core ?? []), ...FORCED_EAGER, ...this.warmNamesFor(agent), ...preload]);
    }
    async preloadNames(agent, entries, runtime) {
        const preload = runtime.preload;
        if (preload?.enabled !== true || runtime.matcher === undefined)
            return [];
        const session = agent?.session;
        if (session === undefined || this.preloadedSessions.has(session.id))
            return [];
        const query = lastUserText(session);
        if (query === '')
            return [];
        this.preloadedSessions.add(session.id);
        try {
            const matches = await searchCatalog(runtime.matcher, query, entries, preload.topK, this.config.matcherTimeoutMs);
            const names = matches.map(match => match.name);
            this.warmTools(agent, names);
            return names;
        }
        catch (error) {
            this.ctx.logger.warn(`dsh-context-optimizer: preload failed: ${errorMessage(error)}`);
            return [];
        }
    }
}

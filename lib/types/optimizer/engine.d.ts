import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt';
import { RuntimeConfigStore } from './config.ts';
import type { CatalogView, SearchOutcome, ToolSearchConfig, UpdateConfigInput, UpdateConfigResult } from './types.ts';
/**
 * A snapshot of the tool surface that will be exposed to a model request.
 * This is deliberately separate from `assemble()` so auditing can report the
 * same tier decision without pretending the full tool registry is injected.
 */
export interface SurfaceAnalysis {
    readonly active: boolean;
    readonly tier: 0 | 1 | 2 | 3;
    readonly registeredTools: number;
    readonly registeredSchemaTokens: number;
    readonly visibleTools: number;
    readonly visibleSchemaTokens: number;
    readonly deferredTools: number;
    readonly manifestTokens: number;
    readonly savedTokens: number;
    readonly warmTools: readonly string[];
}
/**
 * The context optimizer engine resolves runtime config, computes the slimmed
 * model-visible tool surface per assembly, serves the bridge and setup tools,
 * and maintains the per-session warm set that dynamically injects discovered
 * tools back into the visible context. One instance per plugin load.
 */
export declare class ToolSearchEngine {
    private readonly ctx;
    private readonly config;
    private readonly store;
    /** Session id → tool name → last-use sequence (warm set, LRU-bounded). */
    private readonly warm;
    /** Sessions whose preload already ran. */
    private readonly preloadedSessions;
    private warmSeq;
    constructor(ctx: Context, config: ToolSearchConfig, store: RuntimeConfigStore);
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
    assemble(assembly: PromptAssembly, scope: object | undefined): Promise<PromptAssembly>;
    /**
     * Inspect the registered and effective model-visible tool surfaces for one
     * session. The result uses the exact disclosure calculation used by
     * `assemble()`, making optimisation savings observable to the audit layer.
     */
    analyzeSurface(scope: object | undefined): Promise<SurfaceAnalysis>;
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
    search(query: string, limit: number | undefined, scope: object | undefined): Promise<SearchOutcome>;
    /**
     * Resolve the full schema of one catalog tool and warm it into the session.
     * @param name - the tool name.
     * @param scope - the calling agent.
     * @returns the model-facing schema fields, or `undefined` when unknown.
     */
    describe(name: string, scope: object | undefined): {
        name: string;
        description: string;
        parameters: ToolSchema['parameters'];
    } | undefined;
    /** The grouped catalog view the setup skill reads to propose grouping. */
    catalogView(scope: object | undefined): Promise<CatalogView>;
    /**
     * Validate and persist a runtime config update, then drop stale caches.
     * @param input - groups/matcher/preload/core changes and the target scope.
     * @param scope - the calling agent (drives the default scope and workspace).
     * @returns the written path, effective scope, and a summary for the model.
     */
    updateConfig(input: UpdateConfigInput, scope: object | undefined): Promise<UpdateConfigResult>;
    /**
     * Add tools to a session's warm set, LRU-bounded by `maxWarmTools`. Warm
     * tools are injected into the visible context on subsequent assemblies.
     * @param agent - the owning agent (warmth is per session).
     * @param names - tool names to warm.
     */
    warmTools(agent: Agent | undefined, names: readonly string[]): void;
    /** The names of a session's warm tools, in warm order (oldest first). */
    warmNamesFor(agent: Agent | undefined): readonly string[];
    private eagerNames;
    private preloadNames;
}

import type { Context } from '@deepseek-ai/cordis';
import type { SkillRegistry } from '@deepseek-ai/dsh-skill';
import type { ToolSearchEngine } from './engine.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        skills: SkillRegistry;
    }
}
/** The setup/management tool names; always eager and never bridged. */
export declare const MANAGEMENT_NAMES: readonly ["tool_slimmer_catalog", "tool_slimmer_update_config"];
/**
 * Register the setup/management tools the bundled skill drives: a catalog
 * reader and a config writer.
 * @param ctx - the plugin context.
 * @param engine - the engine backing catalog reads and config writes.
 * @returns the combined disposer for both registrations.
 */
export declare function registerManagementTools(ctx: Context, engine: ToolSearchEngine): () => void;
/** The bundled onboarding skill body (registered at plugin load). */
export declare const SETUP_SKILL_CONTENT = "# tool-slimmer-setup\n\nConfigure Context Optimizer: group tools conversationally, configure the rerank matcher, and optionally enable per-session preload.\n\n## When to use\n- The user asks to group tools, set up tool search, configure the rerank model, enable preload, or change where the tool-search config lives.\n- `tool_search` reports \"no rerank matcher configured\" or \"fell back to keyword matching\" and the user wants semantic ranking.\n\n## Workflow\n1. Call `tool_slimmer_catalog` to read the current tool registry catalog (names, descriptions, and existing groups). It lists EVERY tool \u2014 the model-visible set may be smaller when the bridge is active.\n2. Propose a grouping in the conversation: group tools by domain (git, web, mcp-*, media, data, ...), using exact tool names or shared name prefixes. Keep the number of groups small (5-12) and every tool in at most one group.\n3. Present the proposal and ask the user to confirm or adjust. Iterate until the user accepts.\n4. Ask whether the config should be global (user-level) or per-project. When per-project, the config is written to `.dsh/dsh-context-optimizer.json` under the current project.\n5. ALWAYS explain and offer the rerank matcher before writing the config: `tool_search` ranks with it, and it is required for preload. Describe what it is \u2014 an OpenAI-compatible `/v1/rerank` endpoint (for example DashScope compatible-mode with `qwen3-reranker`) \u2014 and ask the user for `endpoint`, `apiKey`, and `model`. If they cannot provide one now, proceed without it: `tool_search` then uses the built-in keyword fallback (exact-name and token matches), which works but ranks less well.\n6. If the user wants preload, set `preload: { enabled: true, topK: 5 }` and confirm the matcher is configured (preload without a matcher stays inactive).\n7. Write the confirmed configuration with `tool_slimmer_update_config` (groups, optional matcher, optional preload), then confirm the written path and the returned summary with the user. Mention that searched/described/called tools are automatically injected into the context for later turns.";
/**
 * Register the bundled onboarding skill so the model can run conversational
 * grouping and matcher setup on request.
 * @param ctx - the plugin context.
 * @returns the skill registration disposer.
 */
export declare function registerSetupSkill(ctx: Context): () => void;

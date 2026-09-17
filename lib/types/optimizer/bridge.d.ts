import type { Context } from '@deepseek-ai/cordis';
import { type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { SearchOutcome } from './types.ts';
/** The three bridge tool names; always eager and never callable through `tool_call`. */
export declare const BRIDGE_NAMES: readonly ["tool_search", "tool_describe", "tool_call"];
/** Services the bridge tools need; implemented by the engine. */
export interface BridgeDeps {
    /** Search over the deferred catalog (rerank with keyword fallback). */
    search(query: string, limit: number | undefined, agent: ToolRunContext['agent']): Promise<SearchOutcome>;
    /** Full schema of one catalog tool, or undefined when unknown. */
    describe(name: string, agent: ToolRunContext['agent']): {
        name: string;
        description: string;
    } | undefined;
    /** Whether a name may be executed through the bridge (registered, not a bridge/management tool). */
    canCall(name: string, agent: ToolRunContext['agent']): boolean;
    /** Inject tools into the session's visible set for subsequent turns. */
    warm(names: readonly string[], agent: ToolRunContext['agent']): void;
}
/**
 * Register the three Hermes-style bridge tools. Each returns a JSON string so
 * the model can parse results directly; failures return a JSON `{ error }`
 * instead of throwing, keeping the guidance model-visible.
 * @param ctx - the plugin context.
 * @param deps - engine-backed search/describe/dispatch services.
 * @returns the combined disposer for all three registrations.
 */
export declare function registerBridgeTools(ctx: Context, deps: BridgeDeps): () => void;

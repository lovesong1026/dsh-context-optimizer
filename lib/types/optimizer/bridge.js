// dsh-llm 0.1.2 renamed the call-id brand `CallId` -> `ToolCallId`.
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
/** The three bridge tool names; always eager and never callable through `tool_call`. */
export const BRIDGE_NAMES = ['tool_search', 'tool_describe', 'tool_call'];
function textRender(_args, value) {
    return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
/**
 * Register the three Hermes-style bridge tools. Each returns a JSON string so
 * the model can parse results directly; failures return a JSON `{ error }`
 * instead of throwing, keeping the guidance model-visible.
 * @param ctx - the plugin context.
 * @param deps - engine-backed search/describe/dispatch services.
 * @returns the combined disposer for all three registrations.
 */
export function registerBridgeTools(ctx, deps) {
    const disposers = [
        ctx.tools.register(defineTool({
            name: 'tool_search',
            description: 'Search the deferred tool catalog (tools hidden to save tokens) and return ranked matches. Matches are injected into the visible context for later turns. Ranking uses the configured rerank matcher with a keyword fallback.',
            parameters: {
                query: { type: 'string', required: true },
                limit: { type: 'integer' },
            },
            output: { schema: { type: 'string' }, render: textRender },
            async execute(args, exec) {
                const { query, limit } = args;
                try {
                    const outcome = await deps.search(query, limit, exec.agent);
                    deps.warm(outcome.matches.map(match => match.name), exec.agent);
                    const payload = { matches: outcome.matches, mode: outcome.mode };
                    if (outcome.hint !== undefined)
                        payload.hint = outcome.hint;
                    return JSON.stringify(payload);
                }
                catch (error) {
                    return JSON.stringify({ error: errorMessage(error) });
                }
            },
        })),
        ctx.tools.register(defineTool({
            name: 'tool_describe',
            description: 'Load the full schema (parameters and description) of one deferred tool by name. The tool becomes visible in the context for later turns.',
            parameters: {
                name: { type: 'string', required: true },
            },
            output: { schema: { type: 'string' }, render: textRender },
            async execute(args, exec) {
                const { name } = args;
                const schema = deps.describe(name, exec.agent);
                if (schema === undefined)
                    return JSON.stringify({ error: `unknown tool "${name}"` });
                deps.warm([name], exec.agent);
                return JSON.stringify(schema);
            },
        })),
        ctx.tools.register(defineTool({
            name: 'tool_call',
            description: 'Invoke a deferred tool by name with its arguments. The call runs as the real tool: approvals, guards, and events use the real tool name. The tool becomes visible in the context for later turns.',
            parameters: {
                name: { type: 'string', required: true },
                arguments: { type: 'object', additionalProperties: true },
            },
            output: { schema: { type: 'string' }, render: textRender },
            async execute(args, exec) {
                const { name, arguments: toolArgs } = args;
                if (!deps.canCall(name, exec.agent)) {
                    return JSON.stringify({ ok: false, error: `tool "${name}" is not callable through tool_call` });
                }
                try {
                    const input = {
                        callId: ToolCallId(`${String(exec.callId)}:tool:${name}`),
                        name,
                        arguments: toolArgs ?? {},
                        signal: exec.signal,
                        ...exec.agent !== undefined ? { agent: exec.agent } : {},
                    };
                    const result = await ctx.tools.execute(input);
                    deps.warm([name], exec.agent);
                    if (result.isError) {
                        const failure = result.error;
                        const detail = failure?.message !== undefined ? String(failure.message) : 'tool call failed';
                        return JSON.stringify({ ok: false, error: detail });
                    }
                    return JSON.stringify({ ok: true, value: result.value });
                }
                catch (error) {
                    return JSON.stringify({ ok: false, error: errorMessage(error) });
                }
            },
        })),
    ];
    return () => { for (const dispose of disposers)
        dispose(); };
}

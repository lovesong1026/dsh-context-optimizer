import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { CatalogEntry, CatalogView, ToolGroupSpec } from './types.ts';
/**
 * Estimate the token cost of manifest text. Conservative upper bound: CJK
 * characters at 1.5 chars/token, everything else at 4 chars/token (the same
 * rule of thumb as the cx-ai TokenEstimationMiddleware).
 * @param text - the manifest text to budget.
 * @returns an estimated token count.
 */
export declare function estimateTokens(text: string): number;
/**
 * Snapshot the model-visible tool catalog as group-annotated rows.
 * @param schemas - the registry's visible schemas (`ctx.tools.schemas(scope)`).
 * @param groups - the configured groups used to annotate each tool.
 * @returns catalog rows in schema order.
 */
export declare function snapshotCatalog(schemas: readonly ToolSchema[], groups: readonly ToolGroupSpec[]): CatalogEntry[];
/**
 * Resolve the full schema for one catalog tool.
 * @param entries - the catalog snapshot.
 * @param name - the tool name to look up.
 * @returns the model-facing schema fields, or `undefined` when unknown.
 */
export declare function describeTool(entries: readonly CatalogEntry[], name: string): {
    name: string;
    description: string;
    parameters: ToolSchema['parameters'];
} | undefined;
/**
 * Build the setup-facing catalog view: per-group counts plus every tool row,
 * annotated with whether each tool is currently deferred (folded behind the
 * bridge) so the setup skill and the model can tell registry from visibility.
 * @param entries - the catalog snapshot.
 * @param deferredNames - tool names currently folded; omitted marks none.
 * @returns the grouped view the setup skill reads.
 */
export declare function buildCatalogView(entries: readonly CatalogEntry[], deferredNames?: ReadonlySet<string>): CatalogView;

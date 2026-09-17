import type { CatalogEntry, ToolGroupSpec } from './types.ts';
/** Names that must never be deferred: the bridge and management tools. */
export declare const FORCED_EAGER: readonly ["tool_search", "tool_describe", "tool_call", "tool_slimmer_catalog", "tool_slimmer_update_config", "skill"];
/**
 * Resolve the group a tool belongs to: first exact-name match, then first
 * prefix match, in declaration order.
 * @param toolName - the registered tool name.
 * @param groups - the configured groups (may be empty).
 * @returns the owning group name, or `undefined` when ungrouped.
 */
export declare function groupFor(toolName: string, groups: readonly ToolGroupSpec[]): string | undefined;
/**
 * Validate group declarations. Returns a human-readable reason when invalid,
 * or `undefined` when the groups are usable.
 * @param groups - the candidate groups from config or the update tool.
 * @returns an error message, or `undefined` when valid.
 */
export declare function validateGroups(groups: readonly ToolGroupSpec[]): string | undefined;
/**
 * Render a grouped manifest of deferred tools for the model. Full mode is
 * "group / name - description"; names mode is "group / name" only.
 * @param entries - the deferred catalog rows (grouped already resolved).
 * @param mode - `full` includes descriptions, `names` lists names only.
 * @returns the manifest text, or an empty string for an empty catalog.
 */
export declare function buildGroupedManifest(entries: readonly CatalogEntry[], mode: 'full' | 'names'): string;
/**
 * Render the tier-3 fallback: one summary line per group plus ungrouped.
 * @param entries - the deferred catalog rows.
 * @returns one line per group ("group name: N tools"), or an empty string.
 */
export declare function buildGroupSummary(entries: readonly CatalogEntry[]): string;

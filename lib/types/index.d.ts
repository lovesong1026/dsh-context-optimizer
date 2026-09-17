/**
 * Context Optimizer for DeepSeek Harness.
 *
 * It combines read-only context auditing with Hermes-style progressive tool
 * disclosure. `context_audit` retains its established name while reporting
 * both the registered tool catalog and the effective model-visible surface.
 */
import type { Context } from '@deepseek-ai/cordis';
import { ToolSearchEngine } from './optimizer/engine.ts';
import type { ToolSearchConfig } from './optimizer/types.ts';
import { type AuditReport } from './audit/audit.ts';
export type { AuditReport } from './audit/audit.ts';
export type { SurfaceAnalysis } from './optimizer/engine.ts';
export declare const name = "dsh-context-optimizer";
export declare const inject: readonly ["fs", "skills", "tools", "sessions"];
/** Static DSH configuration. Runtime grouping and rerank settings remain in the JSON runtime file. */
export interface Config {
    audit?: {
        defaultCwd?: string;
        cacheTtlMs?: number;
    };
    tools?: Partial<ToolSearchConfig>;
}
export interface OptimizedAuditReport extends AuditReport {
    optimization: Awaited<ReturnType<ToolSearchEngine['analyzeSurface']>>;
}
/** Register the unified host plugin. */
export declare function apply(ctx: Context, config?: Config): ToolSearchEngine;

/**
 * Context Optimizer for DeepSeek Harness.
 *
 * It combines read-only context auditing with Hermes-style progressive tool
 * disclosure. `context_audit` retains its established name while reporting
 * both the registered tool catalog and the effective model-visible surface.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { RuntimeConfigStore } from './optimizer/config.ts'
import { ToolSearchEngine } from './optimizer/engine.ts'
import { registerBridgeTools, BRIDGE_NAMES, type BridgeDeps } from './optimizer/bridge.ts'
import { registerManagementTools, registerSetupSkill, MANAGEMENT_NAMES } from './optimizer/setup.ts'
import type { ToolSearchConfig } from './optimizer/types.ts'
import { renderReport, runAudit, type AuditDeps, type AuditReport } from './audit/audit.ts'
import { makeAuditRoutes } from './audit/routes.ts'
import { resolveHostLocale, type HostLocaleId } from './audit/locale.ts'

export type { AuditReport } from './audit/audit.ts'
export type { SurfaceAnalysis } from './optimizer/engine.ts'

export const name = 'dsh-context-optimizer'
export const inject = ['fs', 'skills', 'tools', 'sessions'] as const

const BLOCKED_FROM_BRIDGE = new Set<string>([...BRIDGE_NAMES, ...MANAGEMENT_NAMES, 'skill'])

const DEFAULT_TOOLS: ToolSearchConfig = {
  enabled: 'auto',
  thresholdPct: 5,
  listingMaxTokens: 4000,
  contextWindow: 128000,
  searchDefaultLimit: 5,
  maxSearchLimit: 20,
  minCatalogSize: 12,
  configScope: 'auto',
  core: ['todo_write'],
  matcherTimeoutMs: 15000,
  maxWarmTools: 8,
}

/** Static DSH configuration. Runtime grouping and rerank settings remain in the JSON runtime file. */
export interface Config {
  audit?: { defaultCwd?: string; cacheTtlMs?: number }
  tools?: Partial<ToolSearchConfig>
}

export interface OptimizedAuditReport extends AuditReport {
  optimization: Awaited<ReturnType<ToolSearchEngine['analyzeSurface']>>
}

function reportLocale(ctx: Context): HostLocaleId {
  const settings = ctx.get('settings') as { get(ns: string): unknown } | undefined
  const section = settings?.get('locale') as Record<string, unknown> | undefined
  return resolveHostLocale(section?.preference)
}

function renderOptimization(report: OptimizedAuditReport, locale: HostLocaleId): string {
  const s = report.optimization
  if (locale === 'zh') {
    return `\n\n## 工具面优化\n- 当前档位：Tier ${s.tier}${s.active ? '' : '（未启用瘦身）'}\n- 注册表：${s.registeredTools} 个工具，约 ${s.registeredSchemaTokens} tokens\n- 模型可见：${s.visibleTools} 个 schema + ${s.manifestTokens} tokens 目录\n- 延迟工具：${s.deferredTools} 个；估算节省：${s.savedTokens} tokens\n- Warm 工具：${s.warmTools.length === 0 ? '无' : s.warmTools.join(', ')}`
  }
  return `\n\n## Tool surface optimisation\n- Current tier: Tier ${s.tier}${s.active ? '' : ' (slimming inactive)'}\n- Registry: ${s.registeredTools} tools, about ${s.registeredSchemaTokens} tokens\n- Model-visible: ${s.visibleTools} schemas + ${s.manifestTokens} catalog tokens\n- Deferred: ${s.deferredTools}; estimated savings: ${s.savedTokens} tokens\n- Warm tools: ${s.warmTools.length === 0 ? 'none' : s.warmTools.join(', ')}`
}

/** Register the unified host plugin. */
export function apply(ctx: Context, config: Config = {}): ToolSearchEngine {
  const tools: ToolSearchConfig = { ...DEFAULT_TOOLS, ...config.tools }
  const store = new RuntimeConfigStore(message => ctx.logger.warn(message))
  const engine = new ToolSearchEngine(ctx, tools, store)

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const settled = await next()
    if (tools.enabled === 'off') return settled
    return engine.assemble(settled, context.scope)
  })

  const deps: BridgeDeps = {
    search: (query, limit, agent) => engine.search(query, limit, agent),
    describe: (toolName, agent) => engine.describe(toolName, agent),
    warm: (names, agent) => engine.warmTools(agent, names),
    canCall: (toolName, agent) => !BLOCKED_FROM_BRIDGE.has(toolName) && ctx.tools.get(toolName, agent) !== undefined,
  }
  registerBridgeTools(ctx, deps)
  registerManagementTools(ctx, engine)
  registerSetupSkill(ctx)

  const auditDeps: AuditDeps = { fs: ctx.fs, skills: ctx.skills, tools: ctx.tools }
  const audit = async (args: {
    cwd: string
    signal: AbortSignal
    includeSkillBodies?: boolean
    maxSkillBodies?: number
    detail?: 'summary' | 'developer'
    agent?: object
    locale?: HostLocaleId
  }): Promise<OptimizedAuditReport> => {
    const [report, optimization] = await Promise.all([
      runAudit(auditDeps, { ...args, locale: args.locale ?? reportLocale(ctx) }),
      engine.analyzeSurface(args.agent),
    ])
    return { ...report, optimization }
  }

  ctx.tools.register(defineTool({
    name: 'context_audit',
    description: 'Audit context injected into every model request and report how Context Optimizer reduces the tool surface. Read-only: it never modifies audited files.',
    parameters: {
      cwd: { type: 'string', description: 'Directory to audit. Defaults to the current session workspace.' },
      includeSkillBodies: { type: 'boolean', description: 'Also total skill-body tokens. Defaults to false.' },
      maxSkillBodies: { type: 'number', description: 'Maximum skill bodies to count. Defaults to 20.' },
      detail: { type: 'string', enum: ['summary', 'developer'], description: 'Use developer for a per-entry receipt.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value: Record<string, JsonValue>) => {
        const report = value as unknown as OptimizedAuditReport
        const locale = reportLocale(ctx)
        return [{ type: 'text' as const, text: renderReport(report, locale) + renderOptimization(report, locale) }]
      },
    },
    async execute(args, exec): Promise<Record<string, JsonValue>> {
      const agent = exec.agent as { session?: { header?: { cwd?: string } } } | undefined
      const cwd = args.cwd ?? agent?.session?.header?.cwd ?? config.audit?.defaultCwd ?? process.cwd()
      const report = await audit({
        cwd,
        signal: exec.signal,
        ...(args.includeSkillBodies !== undefined ? { includeSkillBodies: args.includeSkillBodies } : {}),
        ...(args.maxSkillBodies !== undefined ? { maxSkillBodies: args.maxSkillBodies } : {}),
        ...(args.detail === 'developer' ? { detail: 'developer' as const } : {}),
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
      })
      return report as unknown as Record<string, JsonValue>
    },
  }))

  // Keep the established endpoint so the migrated Context Doctor client stays
  // functional. The model-facing audit above is the richer optimisation view.
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const routes = makeAuditRoutes({
    deps: auditDeps,
    runAudit: async ({ cwd, detail, agent, locale }) => audit({
      cwd,
      signal: new AbortController().signal,
      locale,
      ...(detail === 'developer' ? { detail } : {}),
      ...(agent !== undefined ? { agent } : {}),
    }),
    ...(sessions !== undefined ? { sessions: sessions as never } : {}),
    ...(agents !== undefined ? { agents: agents as never } : {}),
    ...(config.audit?.defaultCwd !== undefined ? { defaultCwd: config.audit.defaultCwd } : {}),
    ...(config.audit?.cacheTtlMs !== undefined ? { cacheTtlMs: config.audit.cacheTtlMs } : {}),
  })
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => {
      const disposers = routes.map(route => webCtx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'context-optimizer: routes')
  })
  return engine
}

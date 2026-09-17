import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { makeAuditRoutes } from '../../src/audit/routes.ts'
import type { AuditReport } from '../../src/audit/audit.ts'

/** 最小 WebRoute 处理函数测试辅助：构造 req/res 并捕获响应。 */
function callHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  url: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const res = {
      writeHead(status: number) {
        this.status = status
        return this
      },
      end(payload: string) {
        resolve({ status: this.status, body: JSON.parse(payload) })
      },
    } as ServerResponse & { status: number }
    const req = { method: 'GET', url } as IncomingMessage
    handler(req, res)
  })
}

test('makeAuditRoutes: 返回 audit 路由并返回报告', async () => {
  const fakeReport: AuditReport = {
    tool: 'context_audit',
    version: 1,
    cwd: '/tmp/x',
    injected: {
      instructions: { root: '/tmp/x', files: [], totalTokens: 0, duplicateBlocks: [] },
      skills: { catalogCount: 0, catalogDescriptionTokens: 0, bySource: [], duplicateDescriptions: [] },
      tools: { visibleCount: 0, schemaTokens: 0, nativeCount: 0, nativeTokens: 0, mcp: { servers: [], totalTools: 0, totalTokens: 0 } },
    },
    conflicts: [],
    suggestions: [],
  }
  const routes = makeAuditRoutes({
    deps: {
      fs: {} as never,
      skills: {
        list: async () => [],
      } as never,
      tools: {} as never,
    },
    defaultCwd: '/tmp/x',
    cacheTtlMs: 60_000,
  })
  // 覆盖 runAudit 依赖：直接替换内部 audit 执行（通过把 skills.list 抛错触发失败路径不现实；
  // 这里改为验证路由形状与方法检查）
  assert.equal(routes.length, 1)
  assert.equal(routes[0]!.kind, 'exact')
  assert.equal(routes[0]!.path, '/api/context-optimizer/audit')

  // 方法检查：POST 返回 405
  const res405 = await new Promise<{ status: number }>((resolve) => {
    const res = {
      writeHead(status: number) { this.status = status; return this },
      end() { resolve({ status: this.status }) },
    } as ServerResponse & { status: number }
    routes[0]!.handler({ method: 'POST', url: '/api/context-optimizer/audit' } as IncomingMessage, res)
  })
  assert.equal(res405.status, 405)

  // GET 触发真实审计（skills.list 为空 → 报告可生成）
  const result = await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?cwd=/tmp/x')
  assert.equal(result.status, 200)
  const body = result.body as { ok: boolean; report: AuditReport }
  assert.equal(body.ok, true)
  assert.equal(body.report.tool, 'context_audit')
  assert.equal(body.report.cwd, '/tmp/x')
})

test('makeAuditRoutes: session 参数解析会话 cwd（无显式 cwd 时）', async () => {
  const routes = makeAuditRoutes({
    deps: {
      fs: {} as never,
      skills: { list: async () => [] } as never,
      tools: {} as never,
    },
    sessions: {
      get: (id: string) => id === 'sess-1' ? { header: { cwd: '/workspace/proj' } } : undefined,
    },
  })
  // session 命中：审计落在会话 cwd
  const hit = await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?session=sess-1')
  assert.equal(hit.status, 200)
  const hitBody = hit.body as { ok: boolean; report: AuditReport }
  assert.equal(hitBody.report.cwd, '/workspace/proj')

  // session 未知：回退进程 cwd
  const miss = await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?session=nope')
  assert.equal(miss.status, 200)
  const missBody = miss.body as { ok: boolean; report: AuditReport }
  assert.equal(missBody.report.cwd, process.cwd())

  // 显式 cwd 优先于 session
  const both = await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?cwd=/tmp/z&session=sess-1')
  assert.equal(both.status, 200)
  const bothBody = both.body as { ok: boolean; report: AuditReport }
  assert.equal(bothBody.report.cwd, '/tmp/z')
})

test('makeAuditRoutes: 缓存上限淘汰最旧条目', async () => {
  // 用每次递增的 cwd 打满缓存（> MAX_CACHE_ENTRIES=32），再访问最早的 cwd，
  // 应重新执行审计而非命中缓存（可通过 runAudit 的副作用次数观察——用
  // skills.list 计数器来探测）。
  let listCalls = 0
  const routes = makeAuditRoutes({
    deps: {
      fs: {} as never,
      skills: {
        list: async () => { listCalls++; return [] },
      } as never,
      tools: {} as never,
    },
    defaultCwd: '/tmp/x',
    cacheTtlMs: 60_000,
  })
  // 33 个不同 cwd，超过 32 上限
  for (let i = 0; i < 33; i++) {
    const r = await callHandler(routes[0]!.handler, `/api/context-optimizer/audit?cwd=/tmp/cache-${i}`)
    assert.equal(r.status, 200)
  }
  const callsAfterFill = listCalls
  assert.ok(callsAfterFill >= 33, `预期至少 33 次审计，实际 ${callsAfterFill}`)

  // 再次访问最早条目 /tmp/cache-0：已被淘汰，应重新执行
  const before = listCalls
  const again = await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?cwd=/tmp/cache-0')
  assert.equal(again.status, 200)
  assert.ok(listCalls > before, '最早条目被淘汰后应重新审计')
})

test('makeAuditRoutes: detail=developer 附带 receipt，且与 summary 分开缓存', async () => {
  let listCalls = 0
  const routes = makeAuditRoutes({
    deps: {
      fs: {} as never,
      skills: { list: async () => { listCalls++; return [] } } as never,
      tools: {} as never,
    },
    defaultCwd: '/tmp/detail',
    cacheTtlMs: 60_000,
  })

  // 默认层级：只有摘要，没有 receipt
  const summary = await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?cwd=/tmp/detail')
  assert.equal(summary.status, 200)
  const summaryBody = summary.body as { ok: boolean; report: AuditReport }
  assert.equal(summaryBody.report.receipt, undefined)

  // developer 层级：同一个 cwd，但必须重新审计而不是命中 summary 的缓存
  const before = listCalls
  const developer = await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?cwd=/tmp/detail&detail=developer')
  assert.equal(developer.status, 200)
  assert.ok(listCalls > before, 'detail 层级不同必须绕开 summary 缓存')
  const developerBody = developer.body as { ok: boolean; report: AuditReport }
  assert.ok(developerBody.report.receipt !== undefined, 'detail=developer 应附带 receipt')
  assert.equal(developerBody.report.receipt?.detail, 'developer')

  // 同层级重复请求命中缓存
  const cached = listCalls
  await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?cwd=/tmp/detail&detail=developer')
  assert.equal(listCalls, cached, '同 cwd 同层级应命中缓存')

  // 未知取值退回 summary
  const bogus = await callHandler(routes[0]!.handler, '/api/context-optimizer/audit?cwd=/tmp/detail&detail=nonsense')
  const bogusBody = bogus.body as { ok: boolean; report: AuditReport }
  assert.equal(bogusBody.report.receipt, undefined)
})

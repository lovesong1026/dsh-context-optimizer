/**
 * 发布产物纯度守卫（issue #2）。
 *
 * host 半区的 `lib/index.js` 一旦把宿主运行时（`@deepseek-ai/dsh-tools` 等）
 * 打包进来，插件就会铸造第二份 `ToolRuntime` 与第二个
 * `TOOL_RUNTIME_SCHEDULER` Symbol；宿主 `dsh-agent-loop` 用自己的 Symbol 去查
 * `ctx.tools[TOOL_RUNTIME_SCHEDULER]` 只会拿到 `undefined`，工具调度当场崩在
 * `.prepare()` 上，工具结果写不进会话，后续续聊持续 400。
 *
 * 这几条断言把「宿主包必须是 peer 外置依赖」钉死在测试里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = readFileSync(join(root, 'lib/index.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** 收集 bundle 里的静态 import 裸标识符（含 `export … from`）。 */
function bareImports(source: string): string[] {
  const found = new Set<string>()
  for (const [, spec] of source.matchAll(/(?:^|[\s;}])(?:import|export)\s*(?:[^'"()]*?\bfrom\s*)?["']([^"']+)["']/gm)) {
    if (spec !== undefined && !spec.startsWith('.') && !spec.startsWith('/')) found.add(spec)
  }
  return [...found].sort()
}

/** 裸标识符 → 包名（`@scope/pkg/sub` → `@scope/pkg`）。 */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

test('bundle: 宿主运行时保持外置 import，未被内联', () => {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  const undeclared = bareImports(bundle)
    .filter((s) => !isBuiltin(s))
    .filter((s) => !declared.has(packageOf(s)))
  assert.deepEqual(undeclared, [], `bundle 引用了未声明的包：${undeclared.join(', ')}`)

  // 反向断言：dsh-tools 必须以外置 import 出现，而不是被打进来。
  assert.match(bundle, /from ["']@deepseek-ai\/dsh-tools["']/)
})

test('bundle: 不含第二份 dsh-tools 运行时', () => {
  // 内嵌拷贝的指纹：调度器 Symbol、第二个 tools 服务、code-mode 传输层。
  for (const fingerprint of [
    /Symbol\(["']@deepseek-ai\/dsh-tools\.scheduler["']\)/,
    /TOOL_RUNTIME_SCHEDULER/,
    /super\((?:ctx|\w+), ["']tools["']\)/,
    /extends Service\b/,
  ]) {
    assert.doesNotMatch(bundle, fingerprint, `bundle 内嵌了宿主运行时：${String(fingerprint)}`)
  }
})

test('package.json: 宿主包声明为 peerDependencies', () => {
  const peers = pkg.peerDependencies ?? {}
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools']) {
    assert.ok(peers[name] !== undefined, `${name} 必须是 peerDependencies（宿主提供，不可自带）`)
  }
  // 宿主包只能是 peer；落进 dependencies 会被包管理器装出第二份实体。
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(
      !name.startsWith('@deepseek-ai/'),
      `${name} 不能出现在 dependencies，宿主包一律走 peerDependencies`,
    )
  }
})

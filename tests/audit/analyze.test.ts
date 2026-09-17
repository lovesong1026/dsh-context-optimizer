import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findDuplicateBlocks,
  findDuplicateDescriptions,
  findRankShadows,
  groupMcpTools,
  splitBlocks,
} from '../../src/audit/analyze.ts'

test('splitBlocks: 空行分块', () => {
  const blocks = splitBlocks('line1\nline2\n\nline3\n\n\nline4')
  assert.deepEqual(blocks, ['line1\nline2', 'line3', 'line4'])
})

test('splitBlocks: 空文本', () => {
  assert.deepEqual(splitBlocks(''), [])
  assert.deepEqual(splitBlocks('\n\n'), [])
})

test('findDuplicateBlocks: 跨文件完全相同的块', () => {
  const files = [
    { path: 'a/AGENTS.md', content: '第一条规则\n第二条规则\n\n独特内容 A' },
    { path: 'b/AGENTS.md', content: '第一条规则\n第二条规则\n\n独特内容 B' },
  ]
  const dup = findDuplicateBlocks(files, 5)
  assert.equal(dup.length, 1)
  assert.equal(dup[0]!.text, '第一条规则\n第二条规则')
  assert.deepEqual(dup[0]!.paths, ['a/AGENTS.md', 'b/AGENTS.md'])
})

test('findDuplicateBlocks: 短块被过滤', () => {
  const files = [
    { path: 'a', content: '短' },
    { path: 'b', content: '短' },
  ]
  assert.deepEqual(findDuplicateBlocks(files, 40), [])
})

test('findDuplicateBlocks: 同文件内重复不算', () => {
  const files = [{ path: 'a', content: '同一段落\n\n同一段落' }]
  assert.deepEqual(findDuplicateBlocks(files), [])
})

test('findDuplicateDescriptions: 归一化后相同视为重复', () => {
  const skills = [
    { name: 'skill-a', description: '统计技能的调用次数' },
    { name: 'skill-b', description: '统计技能的调用次数' },
    { name: 'skill-c', description: '  统计技能的调用次数  ' },
    { name: 'skill-d', description: '完全不同的描述' },
  ]
  const dup = findDuplicateDescriptions(skills)
  assert.equal(dup.length, 1)
  assert.equal(dup[0]!.count, 3)
})

test('findRankShadows: 同名技能多来源', () => {
  const skills = [
    { name: 'foo', source: 'project-dsh', provider: 'skill-local', rank: 100 },
    { name: 'foo', source: 'bundled', provider: 'skill-local', rank: 600 },
  ]
  const shadows = findRankShadows(skills)
  assert.equal(shadows.length, 1)
  assert.equal(shadows[0]!.winner.source, 'project-dsh')
  assert.equal(shadows[0]!.shadowed.length, 1)
})

test('findRankShadows: 不同名不算冲突', () => {
  const skills = [
    { name: 'foo', source: 'project-dsh', provider: 'p', rank: 100 },
    { name: 'bar', source: 'bundled', provider: 'p', rank: 600 },
  ]
  assert.deepEqual(findRankShadows(skills), [])
})

test('groupMcpTools: 按服务器分组并估算', () => {
  const schemas = [
    { name: 'mcp__github__create_issue', description: 'Create an issue' },
    { name: 'mcp__github__list_issues', description: 'List issues' },
    { name: 'mcp__web__search', description: 'Search the web' },
    { name: 'native_tool', description: 'A native tool' },
  ]
  const result = groupMcpTools(schemas)
  assert.equal(result.totalTools, 3)
  assert.equal(result.servers.length, 2)
  const github = result.servers.find((s) => s.server === 'github')
  assert.ok(github)
  assert.equal(github.tools, 2)
  assert.ok(github.schemaTokens > 0)
})

test('groupMcpTools: 无 MCP 工具返回空', () => {
  const result = groupMcpTools([{ name: 'read_file', description: 'x' }])
  assert.equal(result.totalTools, 0)
  assert.deepEqual(result.servers, [])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { computeDisclosure, computeTier } from '../src/optimizer/disclosure.ts'

const entries = [
  { name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, group: 'files' },
  { name: 'mcp_github_issue', description: 'Find GitHub issues', parameters: { type: 'object' }, group: 'github' },
  { name: 'mcp_github_pr', description: 'Find pull requests', parameters: { type: 'object' }, group: 'github' },
]

test('progressive disclosure retains eager tools and adds bridge tools', () => {
  const result = computeDisclosure(entries, new Set(['read_file']), new Set(['tool_search', 'tool_describe', 'tool_call']), 1)
  assert.equal(result.tier, 1)
  assert.deepEqual(result.tools.map(tool => tool.name), ['read_file', 'tool_search', 'tool_describe', 'tool_call'])
  assert.match(result.manifest, /mcp_github_issue/)
  assert.match(result.manifest, /NOT directly callable/)
})

test('tier zero leaves the complete catalog visible', () => {
  const result = computeDisclosure(entries, new Set(['read_file']), new Set(['tool_search']), 0)
  assert.equal(result.manifest, '')
  assert.deepEqual(result.tools.map(tool => tool.name), entries.map(entry => entry.name))
})

test('tier calculation uses the names-only and summary fallbacks', () => {
  assert.equal(computeTier({ catalogSize: 20, deferredSize: 10, manifestTokens: 10, namesOnlyTokens: 4, budget: 10, minCatalogSize: 12, forced: false }), 1)
  assert.equal(computeTier({ catalogSize: 20, deferredSize: 10, manifestTokens: 11, namesOnlyTokens: 4, budget: 10, minCatalogSize: 12, forced: false }), 2)
  assert.equal(computeTier({ catalogSize: 20, deferredSize: 10, manifestTokens: 11, namesOnlyTokens: 11, budget: 10, minCatalogSize: 12, forced: false }), 3)
})

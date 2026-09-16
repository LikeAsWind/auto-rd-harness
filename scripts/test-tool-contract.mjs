// Tool definition contract tests.
//
// DSH's verified `ToolDefinition` REQUIRES an `output` member:
//
//   output: { schema: <JsonSchemaNode>, render(args, value): ContentBlock[] }
//
// A definition without it is rejected by `tools.register()`. The three
// auto-rd tools previously declared only name/description/parameters/
// execute, so none of them would have reached the model.
//
// These tests assert the full contract for all three tools, and pin the
// render behaviour.
//
// Run with: node scripts/test-tool-contract.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { autoRdStatusTool } = await import(
  pathToFileURL(resolve(libBase, 'tools', 'auto-rd-status.js')).href
)
const { autoRdTriggerTool } = await import(
  pathToFileURL(resolve(libBase, 'tools', 'auto-rd-trigger.js')).href
)
const { autoRdRetryTool } = await import(
  pathToFileURL(resolve(libBase, 'tools', 'auto-rd-retry.js')).href
)
const { jsonOutput, renderJson, MAX_RENDER_CHARS } = await import(
  pathToFileURL(resolve(libBase, 'tools', 'tool-output.js')).href
)

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) {
    pass += 1
    process.stdout.write(`\u2713 ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`\u2717 ${name}${extra ? ` (${extra})` : ''}\n`)
  }
}

// Minimal storage/logger doubles: the tool builders only close over them.
function fakeStorage(over = {}) {
  const table = (rows) => ({
    *values() {
      for (const r of rows) yield r
    },
  })
  return {
    stories: () => table(over.stories ?? []),
    modules: () => table(over.modules ?? []),
    tasks: () => table(over.tasks ?? []),
  }
}
const fakeLogger = { debug() {}, info() {}, warn() {}, error() {} }

const TOOLS = [
  ['auto_rd_status', autoRdStatusTool({ storage: fakeStorage(), logger: fakeLogger })],
  [
    'auto_rd_trigger',
    autoRdTriggerTool({ storage: fakeStorage(), logger: fakeLogger, pollNow: async () => {} }),
  ],
  ['auto_rd_retry', autoRdRetryTool({ storage: fakeStorage(), logger: fakeLogger })],
]

// ---- every tool satisfies the real ToolDefinition contract -----------

for (const [name, tool] of TOOLS) {
  check(`${name}: name matches`, tool.name === name, tool.name)
  check(`${name}: has a non-empty description`, typeof tool.description === 'string' && tool.description.length > 20)
  check(`${name}: parameters is an object schema`, tool.parameters?.type === 'object', JSON.stringify(tool.parameters?.type))
  check(`${name}: parameters has properties`, typeof tool.parameters?.properties === 'object')

  // The field that was missing.
  check(`${name}: declares output (REQUIRED)`, tool.output !== undefined, JSON.stringify(Object.keys(tool)))
  check(`${name}: output.schema is an object`, tool.output?.schema?.type === 'object', JSON.stringify(tool.output?.schema?.type))
  check(`${name}: output.render is a function`, typeof tool.output?.render === 'function')
  check(`${name}: execute is a function`, typeof tool.execute === 'function')
}

// ---- render returns ContentBlock[] ----------------------------------

for (const [name, tool] of TOOLS) {
  const blocks = tool.output.render({}, { ok: true, value: 1 })
  check(`${name}: render returns an array`, Array.isArray(blocks), typeof blocks)
  check(`${name}: render returns at least one block`, blocks.length >= 1)
  check(
    `${name}: every block has a type`,
    blocks.every((b) => typeof b?.type === 'string'),
    JSON.stringify(blocks),
  )
  check(
    `${name}: renders as a text block for the model`,
    blocks.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.includes('ok')),
    JSON.stringify(blocks),
  )
}

// ---- renderJson -----------------------------------------------------

{
  check('renderJson: pretty-prints an object', renderJson({ a: 1 }).includes('"a": 1'), renderJson({ a: 1 }))
  check('renderJson: handles a string', renderJson('hi') === '"hi"', renderJson('hi'))
  check('renderJson: handles null', renderJson(null) === 'null', renderJson(null))

  // Truncation keeps one call from flooding the context.
  const big = renderJson({ s: 'x'.repeat(MAX_RENDER_CHARS + 500) })
  check('renderJson: truncates oversized output', big.length < MAX_RENDER_CHARS + 200, String(big.length))
  check('renderJson: says it truncated', big.includes('[truncated'), big.slice(-80))

  // Circular structures must not throw.
  const circular = { a: 1 }
  circular.self = circular
  let threw = false
  let out = ''
  try {
    out = renderJson(circular)
  } catch {
    threw = true
  }
  check('renderJson: survives a circular object', threw === false && out.length > 0, out.slice(0, 40))
}

{
  const def = jsonOutput({ properties: { foo: { type: 'string' } } })
  check('jsonOutput: merges caller properties', def.schema.properties.foo.type === 'string')
  check('jsonOutput: always allows extra properties', def.schema.additionalProperties === true)
  check('jsonOutput: schema type defaults to object', def.schema.type === 'object')
  check('jsonOutput: render is callable', def.render({}, { foo: 'bar' })[0].text.includes('bar'))
}

// ---- execute still works end-to-end ---------------------------------

{
  const tool = autoRdStatusTool({
    storage: fakeStorage({
      stories: [
        { id: 'S1', state: 'pending', moduleId: 'm1', title: 't', branch: 'b', updatedAt: '2025-01-01T00:00:00Z' },
        { id: 'S2', state: 'completed', moduleId: 'm1', title: 'u', branch: 'b', updatedAt: '2025-01-02T00:00:00Z' },
      ],
      modules: [{ id: 'm1' }],
      tasks: [{ id: 'T1', status: 'pending' }],
    }),
    logger: fakeLogger,
  })
  const summary = await tool.execute({ scope: 'summary' })
  check('execute: summary scope works', summary.ok === true && summary.totalStories === 2, JSON.stringify(summary))
  check('execute: summary counts by state', summary.byState.pending === 1 && summary.byState.completed === 1)

  const stories = await tool.execute({ scope: 'stories' })
  check('execute: stories scope returns rows', stories.count === 2, JSON.stringify(stories))
  check('execute: stories sorted newest first', stories.stories[0].id === 'S2', JSON.stringify(stories.stories.map((s) => s.id)))

  const filtered = await tool.execute({ scope: 'stories', state: 'pending' })
  check('execute: state filter applies', filtered.count === 1 && filtered.stories[0].id === 'S1')

  const bad = await tool.execute({ scope: 'nonsense' })
  check('execute: invalid params reported, not thrown', bad.ok === false && bad.error === 'invalid_parameters')

  // The rendered form of a real result is what the model would see.
  const rendered = tool.output.render({}, summary)
  check('execute: its own result renders', rendered[0].text.includes('totalStories'), rendered[0].text.slice(0, 60))
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nToolContract tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1

// Audit AGENT-SKILL-MAPPING.md against actual personas/*.md.
//
// Two directions:
//   - forward: mapping says X borrows P, persona cites P
//   - reverse: persona cites P (in body text, not just top-block), check
//     the mapping lists P for that agent -- catches the case where
//     a persona uses a pattern but the mapping omits it.
//
// Run with: node scripts/audit-patterns.mjs

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const baseDir = resolve(__dirname, '..', 'packages', 'dsh-auto-rd')
const personasDir = join(baseDir, 'src', 'agents', 'personas')
const mappingPath = join(baseDir, 'src', 'agents', 'AGENT-SKILL-MAPPING.md')

const mapping = readFileSync(mappingPath, 'utf8')

// Parse the "Agent ↔ Pattern Mapping" table.
// Row format: | **<AgentName>** | <pattern list> | <count> |
const TABLE_HEADER = '| Agent | 借鉴的 Patterns（带 ID） | Pattern 总数 |'
const tableStart = mapping.indexOf(TABLE_HEADER)
const tableEnd = mapping.indexOf('\n## ', tableStart + TABLE_HEADER.length)
const tableSection = mapping.slice(tableStart, tableEnd)
const rows = tableSection.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Agent') && !l.startsWith('|---'))

// Map Agent display name -> filename (in personas/)
const agentToFile = {
  ContextAgent: 'context.md',
  ClarificationAgent: 'clarification.md',
  BrainstormAgent: 'brainstorm.md',
  CriticAgent: 'critic.md',
  DecisionAgent: 'decision.md',
  SpecAgent: 'spec.md',
  PlannerAgent: 'planner.md',
  ImplementationAgent: 'implementation.md',
  TestAgent: 'test.md',
  FixAgent: 'fix.md',
  VerificationAgent: 'verification.md',
  ReviewAgent: 'review.md',
  FinalVerifyAgent: 'final-verify.md',
}

const personaTexts = new Map()
for (const [agent, file] of Object.entries(agentToFile)) {
  personaTexts.set(agent, readFileSync(join(personasDir, file), 'utf8'))
}

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`\u2713 ${name}`)
    pass++
  } else {
    console.log(`\u2717 ${name}`, extra ?? '')
    fail++
  }
}

// Build claimedIds map: Agent -> Set<PatternId>
const claimed = new Map()
for (const row of rows) {
  const cells = row.split('|').map((c) => c.trim()).filter(Boolean)
  if (cells.length < 2) continue
  const agentCell = cells[0].replace(/\*\*/g, '')
  const patternsCell = cells[1]
  const ids = [...patternsCell.matchAll(/\b([A-Z]+-\d+)\b/g)].map((m) => m[1])
  claimed.set(agentCell, new Set(ids))
}

// ---- Forward audit: every claimed pattern appears in its persona ----
console.log('--- Forward: claimed pattern in persona ---')
for (const row of rows) {
  const cells = row.split('|').map((c) => c.trim()).filter(Boolean)
  if (cells.length < 2) continue
  const agentCell = cells[0].replace(/\*\*/g, '')
  const patternsCell = cells[1]
  const ids = [...patternsCell.matchAll(/\b([A-Z]+-\d+)\b/g)].map((m) => m[1])
  if (ids.length === 0) continue
  const persona = personaTexts.get(agentCell)
  if (!persona) {
    check(`persona file exists for ${agentCell}`, false, 'no file mapping')
    continue
  }
  for (const id of ids) {
    const present = persona.includes(id)
    check(`forward: ${agentCell} persona references ${id}`, present, present ? '' : 'NOT FOUND in persona')
  }
}

// ---- Reverse audit: every pattern ID that appears in body text must be claimed ----
//
// We strip the top "Patterns borrowed" block so the reverse audit does
// not flag the IDs that only exist to announce the borrow.
console.log('')
console.log('--- Reverse: persona body pattern is in mapping ---')
const PATTERN_ID_RE = /\b([A-Z]{1,4}-\d+)\b/g
for (const [agent, persona] of personaTexts.entries()) {
  // Find the line that ends the top borrow block.
  // The borrow block is a contiguous run of `> ...` lines at the top of
  // the file (possibly preceded by the title `# ...` line). We split on
  // the first non-`> ` content line.
  const lines = persona.split('\n')
  let bodyStart = 0
  let seenBorrowLine = false
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('> ') && /[A-Z]{1,4}-\d+/.test(l)) {
      seenBorrowLine = true
      continue
    }
    if (seenBorrowLine) {
      bodyStart = i
      break
    }
  }
  const body = lines.slice(bodyStart).join('\n')
  const idsInBody = [...new Set([...body.matchAll(PATTERN_ID_RE)].map((m) => m[1]))]
  const claimedSet = claimed.get(agent) ?? new Set()
  for (const id of idsInBody) {
    if (!claimedSet.has(id)) {
      check(
        `reverse: ${agent} body uses ${id} but mapping doesn't claim it`,
        false,
        `add ${id} to AGENT-SKILL-MAPPING.md for ${agent}`,
      )
    } else {
      check(`reverse: ${agent} body uses ${id} which is claimed`, true)
    }
  }
}

console.log('')
console.log(`Pattern audit: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exitCode = 1
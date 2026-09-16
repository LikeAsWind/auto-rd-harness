// Standalone parser sanity check. Not a formal test framework — just
// confirms the parser produces the expected shape on the planner
// markdown we generated as the stub in M2.
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libPath = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib', 'services', 'planner-parser.js')

const mod = await import(pathToFileURL(libPath).href)
const { parsePlannerMarkdown } = mod

const sample = `
# Implementation Plan — TAPD-MOCK-001

## File Structure Plan
| Spec Section | File(s) | Action |
|--------------|---------|--------|
| §API | src/<feature>.ts | create |
| §Test Plan | tests/<feature>.test.ts | create |

## Tasks

### T001 — Add the failing test
**File(s)**: \`tests/<feature>.test.ts\` (create)
**Depends on**: none
**Estimated**: 3 min

#### Step 1: Write the failing test (RED)
- File: \`tests/<feature>.test.ts\`
- Test name: \`handle<Feature> returns expected response\`
- Assertion: result equals expected stub value

#### Step 2: Verify RED
- Run: \`<test command>\`
- Expected: FAIL with "module not found"

#### Step 3: Minimal implementation (GREEN)
- File: \`src/<feature>.ts\`
- Change: add stub returning the expected value

#### Step 4: Verify GREEN
- Run: \`<test command>\`
- Expected: PASS; full suite still green; no warnings

#### Step 5: Commit
- Message: \`feat(<scope>): add <feature>\`

### T002 — Wire the route
**File(s)**: \`src/routes.ts\` (modify)
**Depends on**: T001
**Estimated**: 4 min

#### Step 1: Write the failing test (RED)
- File: \`tests/routes.test.ts\`
- Test name: \`POST /<feature> returns 200\`
- Assertion: response status is 200

#### Step 3: Minimal implementation (GREEN)
- File: \`src/routes.ts\`
- Change: register the route

#### Step 4: Verify GREEN
- Run: \`<test command>\`
- Expected: PASS

#### Step 5: Commit
- Message: \`feat(<scope>): wire route\`

## Execution Order
T001 → T002
`

const tasks = parsePlannerMarkdown(sample)
let pass = 0, fail = 0
const check = (name, cond) => {
  if (cond) { console.log(`✓ ${name}`); pass++ }
  else { console.log(`✗ ${name}`); fail++ }
}

check('parsed 2 tasks', tasks.length === 2)
check('T001 has 1 file', tasks[0]?.files.length === 1)
check('T001 has dependsOn []', tasks[0]?.dependsOn.length === 0)
check('T001 has red.assertion', !!tasks[0]?.red?.assertion)
check('T001 has green.file', !!tasks[0]?.green?.file)
check('T001 has verify.run', !!tasks[0]?.verify?.run)
check('T001 commit type=feat', tasks[0]?.commit?.type === 'feat')
check('T002 dependsOn = [T001]', tasks[1]?.dependsOn.join(',') === 'T001')
check('T002 has red (no step 2/3 gaps)', !!tasks[1]?.red && !!tasks[1]?.green)
check('T002 commit scope captured', !!tasks[1]?.commit?.scope)

console.log(`\nparser test: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
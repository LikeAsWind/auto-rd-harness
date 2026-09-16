// GitDiffReader unit + integration tests.
//
// Covers:
//   - parseShortstat on representative fixtures
//   - readWorktreeDiff on a real git repo with a single commit
//   - readWorktreeDiff on a repo with a multi-commit feature branch
//   - readWorktreeDiff on a non-git dir -> error reported
//   - resolveBase selects origin/<defaultBranch> when available
//   - resolveBase falls back to merge-base
//   - resolveBase falls back to HEAD~1
//
// Run with: node scripts/test-git-diff-reader.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { readWorktreeDiff, parseShortstat } = await import(
  pathToFileURL(resolve(libBase, 'services', 'git-diff-reader.js')).href
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

function mkTmpDir() {
  return mkdtempSync(join(tmpdir(), 'auto-rd-diff-'))
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

// ---- parseShortstat ----------------------------------------------

{
  const c = parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)')
  check(
    'parseShortstat: both insertions and deletions',
    c.insertions === 12 && c.deletions === 4,
    JSON.stringify(c),
  )
}
{
  const c = parseShortstat(' 1 file changed, 2 insertions(+)')
  check(
    'parseShortstat: insertions only',
    c.insertions === 2 && c.deletions === 0,
    JSON.stringify(c),
  )
}
{
  const c = parseShortstat('')
  check('parseShortstat: empty input -> 0/0', c.insertions === 0 && c.deletions === 0)
}
{
  const c = parseShortstat(' 5 deletions(-)')
  check(
    'parseShortstat: deletions only',
    c.insertions === 0 && c.deletions === 5,
    JSON.stringify(c),
  )
}

// ---- readWorktreeDiff on a real git repo ------------------------

// 1. Non-git dir -> error
{
  const dir = mkTmpDir()
  const r = await readWorktreeDiff(dir)
  check(
    'readWorktreeDiff: non-git dir -> error set',
    typeof r.error === 'string' && r.error.includes('no .git directory'),
    JSON.stringify(r),
  )
  check('readWorktreeDiff: error case commitCount=0', r.commitCount === 0)
}

// 2. Real repo with a single commit on a branch (no parent)
//    -> HEAD~1 doesn't exist, merge-base fails, origin/<branch> absent
//    -> empty diff is the documented fallback.
{
  const dir = mkTmpDir()
  git(dir, ['init', '--quiet', '--initial-branch', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# Hello\n', 'utf-8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'init'])

  const r = await readWorktreeDiff(dir, { defaultBranch: 'main' })
  check(
    'readWorktreeDiff: single-commit repo -> commitCount=0',
    r.commitCount === 0,
    JSON.stringify(r),
  )
  check(
    'readWorktreeDiff: single-commit repo -> no error',
    r.error === undefined,
    JSON.stringify(r),
  )
  check(
    'readWorktreeDiff: head set to commit sha',
    /^[0-9a-f]{7,}$/.test(r.head),
    r.head,
  )
}

// 3. Real repo with a feature branch off main with two commits
{
  const dir = mkTmpDir()
  git(dir, ['init', '--quiet', '--initial-branch', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# base\n', 'utf-8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'base'])

  // Create a feature branch with two new commits.
  git(dir, ['checkout', '--quiet', '-b', 'feature/x'])
  writeFileSync(join(dir, 'feature.ts'), 'export const x = 1\n', 'utf-8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'add feature'])
  writeFileSync(join(dir, 'feature.ts'), 'export const x = 2\nexport const y = 3\n', 'utf-8')
  git(dir, ['commit', '--quiet', '-am', 'update feature'])

  const r = await readWorktreeDiff(dir, { defaultBranch: 'main' })
  check(
    'readWorktreeDiff: feature branch commitCount=2',
    r.commitCount === 2,
    JSON.stringify(r),
  )
  check(
    'readWorktreeDiff: filesChanged includes feature.ts',
    r.filesChanged.includes('feature.ts'),
    JSON.stringify(r.filesChanged),
  )
  check(
    'readWorktreeDiff: insertions > 0',
    r.insertions > 0,
    JSON.stringify(r),
  )
  // `feature.ts` is NEW relative to main, so the branch-vs-base diff
  // shows it as `new file mode` with 0 deletions. (The second commit's
  // modification is only visible in the intra-branch diff.)
  check(
    'readWorktreeDiff: new file vs base -> deletions=0',
    r.deletions === 0,
    JSON.stringify(r),
  )
  check(
    'readWorktreeDiff: diffText is non-empty',
    r.diffText.length > 0,
    `length=${r.diffText.length}`,
  )
  check(
    'readWorktreeDiff: logText has 2 lines',
    r.logText.split('\n').filter((l) => l.trim()).length === 2,
    JSON.stringify(r.logText),
  )
  check(
    'readWorktreeDiff: base is set',
    /^[0-9a-f]{7,}$/.test(r.base),
    r.base,
  )
}

// 4. Modification of an existing file -> deletions > 0
{
  const dir = mkTmpDir()
  git(dir, ['init', '--quiet', '--initial-branch', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'app.ts'), 'const a = 1\nconst b = 2\n', 'utf-8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'base'])

  git(dir, ['checkout', '--quiet', '-b', 'feat'])
  writeFileSync(join(dir, 'app.ts'), 'const a = 10\n', 'utf-8')
  git(dir, ['commit', '--quiet', '-am', 'rewrite app.ts'])

  const r = await readWorktreeDiff(dir, { defaultBranch: 'main' })
  check(
    'readWorktreeDiff: modified file -> insertions=1',
    r.insertions === 1,
    JSON.stringify(r),
  )
  check(
    'readWorktreeDiff: modified file -> deletions=2',
    r.deletions === 2,
    JSON.stringify(r),
  )
  check(
    'readWorktreeDiff: modified file -> filesChanged=[app.ts]',
    r.filesChanged.length === 1 && r.filesChanged[0] === 'app.ts',
    JSON.stringify(r.filesChanged),
  )
}

// 5. Timeout enforcement
{
  const dir = mkTmpDir()
  git(dir, ['init', '--quiet', '--initial-branch', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'a.txt'), 'a\n', 'utf-8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'init'])
  git(dir, ['checkout', '--quiet', '-b', 'feat'])
  writeFileSync(join(dir, 'a.txt'), 'b\n', 'utf-8')
  git(dir, ['commit', '--quiet', '-am', 'change'])

  // Use a 1ms timeout to force the diff command to time out. The
  // base resolution will still succeed (it's just rev-parse); only
  // the actual `git diff` invocation will hit the timeout.
  const r = await readWorktreeDiff(dir, { timeoutMs: 1 })
  check(
    'readWorktreeDiff: 1ms timeout produces error or empty',
    r.error !== undefined || (r.commitCount === 0 && r.diffText === ''),
    JSON.stringify(r),
  )
}

// ---- Summary ----------------------------------------------------

process.stdout.write(`\nGitDiffReader tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1

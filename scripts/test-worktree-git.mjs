// WorktreeGit unit + integration tests against real git repos.
//
// Covers:
//   - isGitRepo on non-git and git dirs
//   - head on non-git (null) and after a commit (sha)
//   - status on a clean repo, after a modification, after a new file
//   - commitWorktreeChanges with no changes -> committed:false + reason
//   - commitWorktreeChanges with a modification -> committed:true + real sha
//   - status is clean again after the commit
//   - explicit `files` staging stages only that path
//   - commit failure (nothing staged even though files listed) is reported
//   - buildCommitMessage variants (type/scope/subject + fallback)
//
// Run with: node scripts/test-worktree-git.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const {
  isGitRepo,
  head,
  status,
  commitWorktreeChanges,
  buildCommitMessage,
  stageFiles,
} = await import(
  pathToFileURL(resolve(libBase, 'services', 'worktree-git.js')).href
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
  return mkdtempSync(join(tmpdir(), 'auto-rd-wtgit-'))
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** Fresh repo with one commit and git identity configured. */
function mkRepo() {
  const dir = mkTmpDir()
  git(dir, ['init', '--quiet', '--initial-branch', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# base\n', 'utf-8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'base'])
  return dir
}

// ---- isGitRepo / head --------------------------------------------

{
  const dir = mkTmpDir()
  check('isGitRepo: plain dir -> false', isGitRepo(dir) === false)
  check('head: plain dir -> null', (await head(dir)) === null)
}

{
  const dir = mkRepo()
  check('isGitRepo: git repo -> true', isGitRepo(dir) === true)
  const h = await head(dir)
  check('head: fresh repo -> sha', typeof h === 'string' && /^[0-9a-f]{7,}$/.test(h), String(h))
}

// ---- status -------------------------------------------------------

{
  const dir = mkRepo()
  const s = await status(dir)
  check('status: clean repo -> clean=true', s.clean === true, JSON.stringify(s))
  check('status: branch is main', s.branch === 'main', s.branch)
  check(
    'status: clean repo -> empty arrays',
    s.modified.length === 0 && s.staged.length === 0 && s.untracked.length === 0,
    JSON.stringify(s),
  )
}

{
  const dir = mkRepo()
  writeFileSync(join(dir, 'README.md'), '# changed\n', 'utf-8')
  const s = await status(dir)
  check('status: modification -> clean=false', s.clean === false)
  check(
    'status: modification -> modified includes README.md',
    s.modified.includes('README.md'),
    JSON.stringify(s),
  )
}

{
  const dir = mkRepo()
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'new.ts'), 'export const x = 1\n', 'utf-8')
  const s = await status(dir)
  check(
    'status: new file -> untracked includes src/new.ts',
    s.untracked.includes('src/new.ts'),
    JSON.stringify(s),
  )
  check('status: new file -> modified empty', s.modified.length === 0, JSON.stringify(s))
}

// ---- commitWorktreeChanges ---------------------------------------

// 1. Clean worktree -> not committed, no throw
{
  const dir = mkRepo()
  const r = await commitWorktreeChanges({ worktreePath: dir, message: 'noop' })
  check('commit: clean worktree -> committed=false', r.committed === false, JSON.stringify(r))
  check(
    'commit: clean worktree -> reason=nothing to commit',
    r.reason === 'nothing to commit',
    r.reason,
  )
  check('commit: clean worktree -> sha is HEAD', typeof r.sha === 'string' && /^[0-9a-f]{7,}$/.test(r.sha))
}

// 2. Non-git dir -> not committed with a clear reason
{
  const dir = mkTmpDir()
  const r = await commitWorktreeChanges({ worktreePath: dir, message: 'x' })
  check('commit: non-git dir -> committed=false', r.committed === false)
  check('commit: non-git dir -> reason mentions git', /git/i.test(r.reason ?? ''), r.reason)
}

// 3. Real modification -> real commit
{
  const dir = mkRepo()
  const before = await head(dir)
  writeFileSync(join(dir, 'README.md'), '# implemented\n', 'utf-8')
  const r = await commitWorktreeChanges({
    worktreePath: dir,
    message: 'feat: implement the thing',
    userName: 'auto-rd',
    userEmail: 'auto-rd@example.com',
  })
  check('commit: modification -> committed=true', r.committed === true, JSON.stringify(r))
  check('commit: modification -> sha is new', typeof r.sha === 'string' && r.sha !== before, `${before} -> ${r.sha}`)
  check(
    'commit: modification -> status snapshot recorded the change',
    r.status.modified.includes('README.md'),
    JSON.stringify(r.status),
  )

  // After the commit the worktree is clean again.
  const after = await status(dir)
  check('commit: worktree clean after commit', after.clean === true, JSON.stringify(after))

  // The commit message landed.
  const log = git(dir, ['log', '-1', '--pretty=%s']).trim()
  check('commit: message persisted', log === 'feat: implement the thing', log)

  // The author is the local identity we set.
  const author = git(dir, ['log', '-1', '--pretty=%an']).trim()
  check('commit: local author identity used', author === 'auto-rd', author)
}

// 4. Untracked file -> committed (git add -A picks it up)
{
  const dir = mkRepo()
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'a.ts'), 'export const a = 1\n', 'utf-8')
  const r = await commitWorktreeChanges({ worktreePath: dir, message: 'feat: add lib/a' })
  check('commit: untracked file -> committed=true', r.committed === true, JSON.stringify(r))
  const tracked = git(dir, ['ls-files']).trim().split('\n')
  check('commit: untracked file now tracked', tracked.includes('lib/a.ts'), JSON.stringify(tracked))
}

// 5. Explicit files list stages only that path
{
  const dir = mkRepo()
  writeFileSync(join(dir, 'README.md'), '# changed\n', 'utf-8')
  writeFileSync(join(dir, 'OTHER.md'), '# other\n', 'utf-8')

  const r = await commitWorktreeChanges({
    worktreePath: dir,
    message: 'docs: only README',
    files: ['README.md'],
  })
  check('commit: explicit files -> committed=true', r.committed === true, JSON.stringify(r))

  const committed = git(dir, ['show', '--name-only', '--pretty=format:', 'HEAD'])
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
  check(
    'commit: explicit files -> only README.md in commit',
    committed.length === 1 && committed[0] === 'README.md',
    JSON.stringify(committed),
  )

  // OTHER.md is still untracked.
  const s = await status(dir)
  check(
    'commit: explicit files -> OTHER.md still untracked',
    s.untracked.includes('OTHER.md'),
    JSON.stringify(s),
  )
}

// 6. Explicit files list that matches nothing -> nothing staged
{
  const dir = mkRepo()
  writeFileSync(join(dir, 'README.md'), '# changed\n', 'utf-8')
  const r = await commitWorktreeChanges({
    worktreePath: dir,
    message: 'x',
    files: ['does-not-exist.ts'],
  })
  check('commit: non-matching files -> committed=false', r.committed === false, JSON.stringify(r))
  check('commit: non-matching files -> reason=nothing staged', r.reason === 'nothing staged', r.reason)
}

// 7. Mixed good + stale paths -> good ones still commit
//    (a single stale planner entry must not discard the real changes)
{
  const dir = mkRepo()
  writeFileSync(join(dir, 'README.md'), '# changed\n', 'utf-8')
  writeFileSync(join(dir, 'GOOD.md'), '# good\n', 'utf-8')

  const r = await commitWorktreeChanges({
    worktreePath: dir,
    message: 'feat: partial stage',
    files: ['README.md', 'GOOD.md', 'stale-path.ts'],
  })
  check('commit: mixed paths -> committed=true', r.committed === true, JSON.stringify(r))

  const committed = git(dir, ['show', '--name-only', '--pretty=format:', 'HEAD'])
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .sort()
  check(
    'commit: mixed paths -> both real files committed',
    committed.length === 2 && committed.includes('README.md') && committed.includes('GOOD.md'),
    JSON.stringify(committed),
  )
}

// 8. stageFiles returns the paths it actually staged
{
  const dir = mkRepo()
  writeFileSync(join(dir, 'README.md'), '# changed\n', 'utf-8')
  const staged = await stageFiles(dir, ['README.md', 'nope.ts'])
  check(
    'stageFiles: returns only the paths that existed',
    staged.length === 1 && staged[0] === 'README.md',
    JSON.stringify(staged),
  )
}

// ---- buildCommitMessage ------------------------------------------

{
  const m = buildCommitMessage({ type: 'feat', scope: 'payment', subject: 'add refund' }, 'fallback')
  check('buildCommitMessage: full triple', m === 'feat(payment): add refund', m)
}
{
  const m = buildCommitMessage({ type: 'fix', subject: 'null guard' }, 'fallback')
  check('buildCommitMessage: no scope', m === 'fix: null guard', m)
}
{
  const m = buildCommitMessage(undefined, 'implement T001')
  check('buildCommitMessage: no payload -> default feat', m === 'feat: implement T001', m)
}
{
  const m = buildCommitMessage({ scope: 'api' }, 'do the thing')
  check('buildCommitMessage: scope only -> default type', m === 'feat(api): do the thing', m)
}
{
  const m = buildCommitMessage({ type: '', scope: '', subject: '' }, 'fallback subject')
  check('buildCommitMessage: empty strings -> fallbacks', m === 'feat: fallback subject', m)
}

// ---- Summary ------------------------------------------------------

process.stdout.write(`\nWorktreeGit tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1

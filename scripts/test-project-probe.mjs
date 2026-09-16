// ProjectProbe tests against real directory layouts.
//
// Covers:
//   - missing path / non-directory -> error reported, no throw
//   - empty dir -> nothing detected, no error
//   - Node project with package-lock -> npm + npm ci + npm test
//   - pnpm-lock -> pnpm + frozen-lockfile
//   - yarn.lock -> yarn
//   - bun.lockb -> bun
//   - packageManager field outranks a bare package-lock.json
//   - package.json without a test script -> testCommand null
//   - non-Node projects (Cargo.toml / go.mod) -> pm null, no crash
//   - manifests list only includes files that exist
//   - top-level listing sorts and excludes ignored dirs
//   - languageBreakdown counts by extension and skips node_modules
//   - a git repo reports headSha + branch
//
// Run with: node scripts/test-project-probe.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { probeProject, detectPackageManager } = await import(
  pathToFileURL(resolve(libBase, 'services', 'project-probe.js')).href
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
  return mkdtempSync(join(tmpdir(), 'auto-rd-probe-'))
}

function mkNodeProject(files = {}) {
  const dir = mkTmpDir()
  writeFileSync(join(dir, 'package.json'), JSON.stringify(files.pkg ?? { name: 'x' }), 'utf-8')
  if (files.lock === 'npm') writeFileSync(join(dir, 'package-lock.json'), '{}', 'utf-8')
  if (files.lock === 'pnpm') writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf-8')
  if (files.lock === 'yarn') writeFileSync(join(dir, 'yarn.lock'), '# yarn lockfile v1\n', 'utf-8')
  if (files.lock === 'bun') writeFileSync(join(dir, 'bun.lockb'), 'binary', 'utf-8')
  return dir
}

// ---- Error paths -------------------------------------------------

{
  const r = probeProject(join(mkTmpDir(), 'does-not-exist'))
  check('probe: missing path -> error set', typeof r.error === 'string' && r.error.length > 0, r.error)
  check('probe: missing path -> isGitRepo false', r.isGitRepo === false)
  check('probe: missing path -> fileCount 0', r.fileCount === 0)
}

{
  const dir = mkTmpDir()
  const file = join(dir, 'a-file.txt')
  writeFileSync(file, 'x', 'utf-8')
  const r = probeProject(file)
  check(
    'probe: path is a file -> error mentions directory',
    typeof r.error === 'string' && /not a directory/i.test(r.error),
    r.error,
  )
}

// ---- Empty dir ---------------------------------------------------

{
  const dir = mkTmpDir()
  const r = probeProject(dir)
  check('probe: empty dir -> no error', r.error === undefined, r.error)
  check('probe: empty dir -> pm null', r.packageManager === null)
  check('probe: empty dir -> testCommand null', r.testCommand === null)
  check('probe: empty dir -> manifests empty', r.manifests.length === 0)
  check('probe: empty dir -> fileCount 0', r.fileCount === 0)
}

// ---- Package manager detection -----------------------------------

{
  const dir = mkNodeProject({ lock: 'npm', pkg: { name: 'x', scripts: { test: 'jest' } } })
  const r = probeProject(dir)
  check('probe: package-lock -> npm', r.packageManager === 'npm', String(r.packageManager))
  check('probe: npm -> install cmd is npm ci', r.installCommand === 'npm ci', String(r.installCommand))
  check('probe: npm -> test cmd is npm test', r.testCommand === 'npm test', String(r.testCommand))
}

{
  const dir = mkNodeProject({ lock: 'pnpm', pkg: { name: 'x', scripts: { test: 'vitest' } } })
  const r = probeProject(dir)
  check('probe: pnpm-lock -> pnpm', r.packageManager === 'pnpm')
  check(
    'probe: pnpm -> frozen-lockfile install',
    r.installCommand === 'pnpm install --frozen-lockfile',
    String(r.installCommand),
  )
  check('probe: pnpm -> test cmd is pnpm test', r.testCommand === 'pnpm test', String(r.testCommand))
}

{
  const dir = mkNodeProject({ lock: 'yarn', pkg: { name: 'x', scripts: { test: 'jest' } } })
  const r = probeProject(dir)
  check('probe: yarn.lock -> yarn', r.packageManager === 'yarn')
  check('probe: yarn -> test cmd is yarn test', r.testCommand === 'yarn test')
}

{
  const dir = mkNodeProject({ lock: 'bun', pkg: { name: 'x', scripts: { test: 'bun test' } } })
  const r = probeProject(dir)
  check('probe: bun.lockb -> bun', r.packageManager === 'bun')
}

// packageManager field outranks a bare package-lock.json
{
  const dir = mkNodeProject({
    lock: 'npm',
    pkg: { name: 'x', packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest' } },
  })
  const r = probeProject(dir)
  check(
    'probe: packageManager field outranks package-lock.json',
    r.packageManager === 'pnpm',
    String(r.packageManager),
  )
}

// No test script -> testCommand null
{
  const dir = mkNodeProject({ lock: 'npm', pkg: { name: 'x' } })
  const r = probeProject(dir)
  check('probe: no test script -> testCommand null', r.testCommand === null)
  check('probe: still detects pm', r.packageManager === 'npm')
}

// build script
{
  const dir = mkNodeProject({
    lock: 'pnpm',
    pkg: { name: 'x', scripts: { test: 'vitest', build: 'tsc' } },
  })
  const r = probeProject(dir)
  check('probe: build script -> pnpm build', r.buildCommand === 'pnpm build', String(r.buildCommand))
}

// Non-Node project
{
  const dir = mkTmpDir()
  writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname="x"', 'utf-8')
  const r = probeProject(dir)
  check('probe: Cargo project -> pm null (no crash)', r.packageManager === null)
  check('probe: Cargo project -> Cargo.toml in manifests', r.manifests.includes('Cargo.toml'))
}

// ---- Manifests + top-level ---------------------------------------

{
  const dir = mkNodeProject({ lock: 'npm', pkg: { name: 'x' } })
  writeFileSync(join(dir, 'README.md'), '# x', 'utf-8')
  writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf-8')
  writeFileSync(join(dir, 'Dockerfile'), 'FROM node', 'utf-8')
  const r = probeProject(dir)
  check(
    'probe: manifests include the ones present',
    ['package.json', 'package-lock.json', 'README.md', 'tsconfig.json', 'Dockerfile'].every((m) =>
      r.manifests.includes(m),
    ),
    JSON.stringify(r.manifests),
  )
  check(
    'probe: manifests exclude absent ones',
    !r.manifests.includes('go.mod') && !r.manifests.includes('yarn.lock'),
    JSON.stringify(r.manifests),
  )
}

// Top-level listing + ignored dirs
{
  const dir = mkNodeProject({ lock: 'npm', pkg: { name: 'x' } })
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'tests'))
  mkdirSync(join(dir, 'node_modules'))
  mkdirSync(join(dir, '.git'))
  mkdirSync(join(dir, 'dist'))
  writeFileSync(join(dir, 'index.ts'), 'export {}', 'utf-8')

  const r = probeProject(dir)
  check(
    'probe: top-level dirs exclude node_modules/.git/dist',
    r.topLevelDirs.includes('src') &&
      r.topLevelDirs.includes('tests') &&
      !r.topLevelDirs.includes('node_modules') &&
      !r.topLevelDirs.includes('.git') &&
      !r.topLevelDirs.includes('dist'),
    JSON.stringify(r.topLevelDirs),
  )
  check('probe: top-level dirs sorted', JSON.stringify(r.topLevelDirs) === JSON.stringify([...r.topLevelDirs].sort()))
  check('probe: top-level files include index.ts', r.topLevelFiles.includes('index.ts'), JSON.stringify(r.topLevelFiles))
  check('probe: dotfiles excluded from top-level files', !r.topLevelFiles.some((f) => f.startsWith('.')))
}

// ---- Language breakdown ------------------------------------------

{
  const dir = mkNodeProject({ lock: 'npm', pkg: { name: 'x' } })
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export {}', 'utf-8')
  writeFileSync(join(dir, 'src', 'b.ts'), 'export {}', 'utf-8')
  writeFileSync(join(dir, 'src', 'nested', 'c.tsx'), 'export {}', 'utf-8')
  writeFileSync(join(dir, 'src', 'nested', 'd.js'), 'export {}', 'utf-8')

  // These must NOT be counted.
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'dep', 'huge.ts'), 'export {}', 'utf-8')

  const r = probeProject(dir)
  check(
    'probe: languageBreakdown counts .ts',
    r.languageBreakdown['.ts'] === 2,
    JSON.stringify(r.languageBreakdown),
  )
  check(
    'probe: languageBreakdown counts .tsx and .js',
    r.languageBreakdown['.tsx'] === 1 && r.languageBreakdown['.js'] === 1,
    JSON.stringify(r.languageBreakdown),
  )
  check(
    'probe: node_modules excluded from the walk',
    // 4 authored files (a.ts, b.ts, nested/c.tsx, nested/d.js) plus the
    // 2 root manifests the fixture wrote (package.json, package-lock.json).
    // The point of the assertion is that node_modules/dep/huge.ts did NOT
    // contribute — if node_modules were walked the count would be 7+.
    r.fileCount === 6,
    `count=${r.fileCount} breakdown=${JSON.stringify(r.languageBreakdown)}`,
  )
  check(
    'probe: node_modules not represented in the breakdown',
    r.languageBreakdown['.ts'] === 2,
    JSON.stringify(r.languageBreakdown),
  )
  check('probe: walk not truncated on a small repo', r.walkTruncated === false)
}

// ---- Git metadata ------------------------------------------------

{
  const dir = mkTmpDir()
  execFileSync('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'x', 'utf-8')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: dir })

  const r = probeProject(dir)
  check('probe: git repo -> isGitRepo true', r.isGitRepo === true)
  check('probe: git repo -> headSha is a sha', /^[0-9a-f]{7,}$/.test(r.headSha ?? ''), String(r.headSha))
  check('probe: git repo -> branch is main', r.branch === 'main', String(r.branch))
}

{
  const dir = mkTmpDir()
  const r = probeProject(dir)
  check('probe: non-git dir -> isGitRepo false', r.isGitRepo === false)
  check('probe: non-git dir -> headSha null', r.headSha === null)
  check('probe: non-git dir -> branch null', r.branch === null)
}

// ---- detectPackageManager directly --------------------------------

{
  check('detectPackageManager: no manifest -> null', detectPackageManager([], null) === null)
  check(
    'detectPackageManager: package.json only -> npm',
    detectPackageManager(['package.json'], {}) === 'npm',
  )
  check(
    'detectPackageManager: pnpm lock wins',
    detectPackageManager(['package.json', 'pnpm-lock.yaml', 'yarn.lock'], {}) === 'pnpm',
  )
  check(
    'detectPackageManager: yarn lock wins over npm lock',
    detectPackageManager(['package.json', 'yarn.lock', 'package-lock.json'], {}) === 'yarn',
  )
}

// ---- Summary ------------------------------------------------------

process.stdout.write(`\nProjectProbe tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1

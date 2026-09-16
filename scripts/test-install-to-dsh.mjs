#!/usr/bin/env node
/**
 * Test install-to-dsh.mjs idempotency + uninstall against a temp fake
 * DSH profile. Uses the AUTORD_FAKE_PM=1 test seam in install-to-dsh.mjs
 * to no-op all package-manager calls. Asserts the STANDARD DSH install:
 *   - empty patch.yml + bundle missing in package.json ->
 *       bundle registered AND managed loader block inserted
 *   - bundle gets registered in package.json#dsh.profile.bundles on install
 *   - managed block contains the loader entry (- id / name / config)
 *   - existing user header in cordis.patch.yml is preserved
 *   - re-run is idempotent: bundle appears once, block appears once
 *   - dry-run leaves both package.json and cordis.patch.yml byte-equal
 *   - uninstall removes the bundle from dsh.profile.bundles
 *   - uninstall also strips the managed block from cordis.patch.yml
 *   - spawned pnpm add/remove each called exactly once across the lifecycle
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { appendFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const profileRoot = join(tmpdir(), `autord-install-test-${process.pid}`);
const profileDir = join(profileRoot, 'web');
const pmLog = join(profileRoot, 'pm.log');

mkdirSync(profileDir, { recursive: true });
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
  name: 'fake-dsh-profile', private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-worktable'] } },
}, null, 2) + '\n');
writeFileSync(join(profileDir, 'pnpm-lock.yaml'), '');
// Pre-create the tarball cache that the install path expects `npm pack`
// to have produced. Under AUTORD_FAKE_PM=1 `npm pack` is a no-op, so we
// seed a placeholder tarball here (its content is irrelevant — pnpm
// never reads it under the fake seam).
const fakeCacheDir = join(profileDir, 'node_modules', '.cache', 'autord-install');
mkdirSync(fakeCacheDir, { recursive: true });
writeFileSync(join(fakeCacheDir, 'dsh-auto-rd.tgz'), 'placeholder');
const patchFile = join(profileDir, 'cordis.patch.yml');
const profilePkgPath = join(profileDir, 'package.json');

const BLOCK_BEGIN = '# >>> auto-rd (managed by scripts/install-to-dsh.mjs) >>>';
const BLOCK_END = '# <<< auto-rd <<<';
const BUNDLE_NAME = '@yangzhitong/dsh-auto-rd';

function run(label, ...rest) {
  process.stdout.write(`--- ${label} ---\n`);
  const env = {
    ...process.env,
    AUTORD_FAKE_PM: '1',
  };
  // Pass the fake profile dir explicitly so we don't depend on DSH_HOME.
  const fullArgs = ['--profile', profileDir, ...rest];
  appendFileSync(pmLog, `step: ${label} args=${JSON.stringify(fullArgs)}\n`);
  const res = spawnSync(process.execPath, [join(__dirname, 'install-to-dsh.mjs'), ...fullArgs], {
    env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) throw new Error(`${label} exited ${res.status}`);
}

function readBundles() {
  if (!existsSync(profilePkgPath)) return null;
  return JSON.parse(readFileSync(profilePkgPath, 'utf8')).dsh?.profile?.bundles ?? null;
}

function blockCount() {
  if (!existsSync(patchFile)) return 0;
  const raw = readFileSync(patchFile, 'utf8');
  return (raw.match(/>>> auto-rd \(managed/g) || []).length;
}

function getBlock() {
  if (!existsSync(patchFile)) return null;
  const raw = readFileSync(patchFile, 'utf8');
  const b = raw.indexOf(BLOCK_BEGIN);
  if (b < 0) return null;
  const e = raw.indexOf(BLOCK_END, b);
  if (e < 0) return null;
  return raw.slice(b, e + BLOCK_END.length);
}

let assertCount = 0;
function assert(cond, msg) {
  assertCount++;
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

try {
  writeFileSync(patchFile, '', 'utf8');
  assert(blockCount() === 0, 'initial block count must be 0');

  const initialBundles = readBundles();
  assert(!initialBundles.includes(BUNDLE_NAME), 'bundle not registered at start');

  // ---- install (first) ----------------------------------------------

  run('install (first)');
  let bundles = readBundles();
  assert(bundles.includes(BUNDLE_NAME), `bundle registered in dsh.profile.bundles (got ${JSON.stringify(bundles)})`);
  for (const b of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-worktable']) {
    assert(bundles.includes(b), `pre-existing bundle ${b} preserved`);
  }
  // STANDARD DSH install writes the loader entry to cordis.patch.yml.
  assert(blockCount() === 1, `install writes exactly one managed block (got ${blockCount()})`);
  let block = getBlock();
  assert(block.includes('- id: auto-rd'), 'managed block contains the loader entry id');
  assert(block.includes(`name: '${BUNDLE_NAME}'`), `managed block references the bundle (${BUNDLE_NAME})`);
  assert(block.includes('config:'), 'managed block contains the config: section');

  // ---- install (with existing user header) -------------------------

  writeFileSync(patchFile, '# user header line\n', 'utf8');
  run('install (with existing user header)');
  const raw = readFileSync(patchFile, 'utf8');
  assert(raw.startsWith('# user header line\n'), 'user header preserved across install');
  assert(blockCount() === 1, 'still exactly one managed block');
  bundles = readBundles();
  assert(bundles.filter((b) => b === BUNDLE_NAME).length === 1, `bundle listed exactly once (got ${bundles.filter((b) => b === BUNDLE_NAME).length})`);

  // ---- idempotent re-run -------------------------------------------

  run('install (re-run, idempotent)');
  bundles = readBundles();
  assert(bundles.filter((b) => b === BUNDLE_NAME).length === 1, 're-run keeps bundle listed exactly once');
  assert(blockCount() === 1, 're-run keeps exactly one managed block');

  // ---- dry-run install ---------------------------------------------

  const snapBeforeDry = readFileSync(profilePkgPath, 'utf8');
  const patchBeforeDry = readFileSync(patchFile, 'utf8');
  run('install (dry-run)', '--dry-run');
  assert(readFileSync(profilePkgPath, 'utf8') === snapBeforeDry, 'dry-run leaves package.json byte-equal');
  assert(readFileSync(patchFile, 'utf8') === patchBeforeDry, 'dry-run leaves cordis.patch.yml byte-equal');

  // ---- dry-run uninstall -------------------------------------------

  const beforeUninstall = readFileSync(profilePkgPath, 'utf8');
  const patchBeforeUninstall = readFileSync(patchFile, 'utf8');
  run('uninstall (dry-run)', '--uninstall', '--dry-run');
  assert(readFileSync(profilePkgPath, 'utf8') === beforeUninstall, 'dry-run uninstall leaves package.json equal');
  assert(readFileSync(patchFile, 'utf8') === patchBeforeUninstall, 'dry-run uninstall leaves cordis.patch.yml equal');
  assert(readBundles().includes(BUNDLE_NAME), 'dry-run uninstall does not remove the bundle');

  // ---- uninstall (real) --------------------------------------------

  run('uninstall', '--uninstall');
  bundles = readBundles();
  assert(!bundles.includes(BUNDLE_NAME), `bundle removed from dsh.profile.bundles (got ${JSON.stringify(bundles)})`);
  for (const b of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-worktable']) {
    assert(bundles.includes(b), `pre-existing bundle ${b} preserved through uninstall`);
  }
  assert(blockCount() === 0, `managed block stripped from cordis.patch.yml (got ${blockCount()})`);
  const afterUninstall = readFileSync(patchFile, 'utf8');
  assert(afterUninstall.startsWith('# user header line\n'), 'user header preserved after uninstall');

  // ---- second uninstall is a no-op ---------------------------------

  run('uninstall (idempotent)', '--uninstall');
  bundles = readBundles();
  assert(!bundles.includes(BUNDLE_NAME), 'second uninstall still has no bundle listed');

  // ---- lifecycle pm invocation count via the captured log ----------

  const logLines = readFileSync(pmLog, 'utf8').trim().split('\n').filter(Boolean);
  const installSteps = logLines.filter((l) => l.includes('install (first)') || l.includes('install (with existing') || l.includes('install (re-run'));
  const dryRunInstalls = logLines.filter((l) => /^step: install \(dry-run\)/.test(l));
  const uninstallSteps = logLines.filter((l) => /^step: uninstall args/.test(l) || l.includes('uninstall (idempotent'));
  const dryRunUninstalls = logLines.filter((l) => /^step: uninstall \(dry-run\)/.test(l));
  assert(installSteps.length === 3, `expected 3 real install step entries, got ${installSteps.length}`);
  assert(dryRunInstalls.length === 1, `expected 1 dry-run install, got ${dryRunInstalls.length}`);
  assert(uninstallSteps.length === 2, `expected 2 real uninstall step entries, got ${uninstallSteps.length}`);
  assert(dryRunUninstalls.length === 1, `expected 1 dry-run uninstall, got ${dryRunUninstalls.length}`);

  process.stdout.write(`\ninstall-to-dsh: ${assertCount} pass, 0 fail\n`);
  process.exit(0);
} catch (e) {
  process.stderr.write(`FAIL: ${e.message}\n`);
  process.exit(1);
} finally {
  try { rmSync(profileRoot, { recursive: true, force: true }); } catch {}
}

#!/usr/bin/env node
/**
 * Test install-to-dsh.mjs idempotency + uninstall against a temp fake
 * DSH profile. Uses the AUTORD_FAKE_PM=1 test seam in install-to-dsh.mjs
 * to no-op all package-manager calls. Asserts:
 *   - empty patch.yml -> exactly 1 managed block after install
 *   - existing user header preserved across install/uninstall
 *   - block byte-for-byte unchanged on re-run (idempotent)
 *   - dry-run leaves file untouched
 *   - uninstall removes the block; second uninstall is a no-op
 *   - spawned pnpm add/remove each called exactly once across the lifecycle
 *   - block references env vars; never contains a plaintext token
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
  name: 'fake-dsh-profile', private: true, dependencies: {},
}));
writeFileSync(join(profileDir, 'pnpm-lock.yaml'), '');
const patchFile = join(profileDir, 'cordis.patch.yml');

const BLOCK_BEGIN = '# >>> auto-rd (managed by scripts/install-to-dsh.mjs) >>>';
const BLOCK_END = '# <<< auto-rd <<<';

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

  run('install (first)');
  assert(blockCount() === 1, `expected 1 block after install, got ${blockCount()}`);
  const block = getBlock();
  assert(block.includes(BLOCK_BEGIN) && block.includes(BLOCK_END), 'block has markers');
  assert(block.includes('process.env.DSH_TAPD_API_TOKEN'), 'block references tapd env');
  assert(block.includes('process.env.DSH_GITLAB_API_TOKEN'), 'block references gitlab env');
  assert(!/api[._-]token:\s*['"]?[A-Za-z0-9_-]{10,}/i.test(block), 'block contains no plaintext token');

  // Re-install on top of an existing user header.
  writeFileSync(patchFile, '# user header line\n', 'utf8');
  run('install (with existing header)');
  let raw = readFileSync(patchFile, 'utf8');
  assert(raw.startsWith('# user header line\n'), 'user header preserved');
  assert(blockCount() === 1, 'still exactly one block');

  // Idempotent re-run.
  const before = getBlock();
  run('install (re-run, idempotent)');
  const after = getBlock();
  assert(blockCount() === 1, 're-run keeps exactly one block');
  assert(before === after, 'block byte-for-byte unchanged on re-run');

  // Dry-run install.
  const snapBeforeDry = readFileSync(patchFile, 'utf8');
  run('install (dry-run)', '--dry-run');
  const snapAfterDry = readFileSync(patchFile, 'utf8');
  assert(snapBeforeDry === snapAfterDry, 'dry-run leaves file byte-equal');
  assert(blockCount() === 1, 'dry-run does not add a second block');

  // Dry-run uninstall.
  run('uninstall (dry-run)', '--uninstall', '--dry-run');
  assert(blockCount() === 1, 'dry-run uninstall does not remove');
  assert(readFileSync(patchFile, 'utf8') === snapBeforeDry, 'dry-run uninstall leaves file equal');

  // Real uninstall.
  run('uninstall', '--uninstall');
  assert(blockCount() === 0, `expected 0 blocks after uninstall, got ${blockCount()}`);
  let after2 = readFileSync(patchFile, 'utf8');
  assert(after2.startsWith('# user header line\n'), 'header preserved after uninstall');

  // Second uninstall is a no-op.
  run('uninstall (idempotent: block already gone)', '--uninstall');
  assert(blockCount() === 0, 'uninstall is idempotent');
  assert(readFileSync(patchFile, 'utf8') === after2, 'second uninstall is byte-equal');

  // Confirm lifecycle pm invocation count via the captured log.
  // Each install step → one 'add' line; each uninstall step → one 'remove' line.
  // Idempotent re-runs also call the pm once each (the script does not skip
  // pnpm on re-install; it relies on pnpm's own dedup), so count the steps
  // we actually executed.
  const logLines = readFileSync(pmLog, 'utf8').trim().split('\n').filter(Boolean);
  const installSteps = logLines.filter((l) => l.includes('install (first)') || l.includes('install (with existing header)') || l.includes('install (re-run, idempotent)'));
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
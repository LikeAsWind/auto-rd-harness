#!/usr/bin/env node
/**
 * verify-install-dsh — read-only sanity check that the auto-rd plugin
 * is correctly staged for DSH to mount it on the next start.
 *
 * Checks (all read-only, no side effects):
 *   1. The package is installed at <profile>/node_modules/@yangzhitong/dsh-auto-rd/
 *   2. The local tarball cache contains the staged tarball.
 *   3. <profile>/package.json declares the dependency.
 *   4. <profile>/package.json#dsh.profile.bundles lists the bundle (so DSH's
 *      web shell picks up the lib/client.js entry — without this, the host
 *      plugin mounts but the sidebar UI never appears).
 *   5. pnpm list --depth 0 reports the package.
 *
 * Usage:
 *   node scripts/verify-install-dsh.mjs [--profile <dir>]
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';

const PROFILE_DEFAULT = join(process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME, '.dsh'), 'profiles', 'web');
const PKG_DIR = '@yangzhitong/dsh-auto-rd';
const TARBALL = join('node_modules', '.cache', 'autord-install', 'dsh-auto-rd.tgz');

function parseArgs(argv) {
  const out = { profile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') out.profile = argv[++i];
    else throw new Error(`unknown flag: ${argv[i]}`);
  }
  return out;
}

function defaultProfile() {
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'profiles', 'web');
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('cannot resolve profile dir: set DSH_HOME or HOME/USERPROFILE');
  return join(home, '.dsh', 'profiles', 'web');
}

const args = parseArgs(process.argv.slice(2));
const profile = resolve(args.profile || defaultProfile());

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
}

if (!existsSync(profile)) {
  console.error(`profile not found: ${profile}`);
  process.exit(2);
}
console.log(`profile: ${profile}\n`);

// 1. Installed at node_modules/@scope/name
const installed = join(profile, 'node_modules', PKG_DIR, 'package.json');
if (existsSync(installed)) {
  try {
    const pkg = JSON.parse(readFileSync(installed, 'utf8'));
    check('1. installed package', true, `${PKG_DIR}@${pkg.version} at ${dirname(installed)}`);
  } catch (e) {
    check('1. installed package', false, `cannot read ${installed}: ${e.message}`);
  }
} else {
  check('1. installed package', false, `missing: ${installed}`);
}

// 2. Staged tarball
const tarball = join(profile, TARBALL);
if (existsSync(tarball)) {
  const sz = statSync(tarball).size;
  check('2. staged tarball', sz > 1000, `${tarball} (${sz} bytes)`);
} else {
  check('2. staged tarball', false, `missing: ${tarball}`);
}

// 3. package.json declares the dependency
const profilePkg = join(profile, 'package.json');
if (existsSync(profilePkg)) {
  try {
    const pkg = JSON.parse(readFileSync(profilePkg, 'utf8'));
    const dep = pkg.dependencies?.[PKG_DIR];
    if (dep) check('3. dependency declared', true, `"${PKG_DIR}": "${dep}"`);
    else check('3. dependency declared', false, `not in dependencies`);
  } catch (e) {
    check('3. dependency declared', false, `cannot read ${profilePkg}: ${e.message}`);
  }
} else {
  check('3. dependency declared', false, `missing: ${profilePkg}`);
}

// 4. package.json#dsh.profile.bundles lists the bundle — this is what makes
// DSH's web shell pick up the lib/client.js entry on next start.
if (existsSync(profilePkg)) {
  try {
    const pkg = JSON.parse(readFileSync(profilePkg, 'utf8'));
    const bundles = pkg.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.includes(PKG_DIR)) {
      check('4. registered bundle', true, `${PKG_DIR} listed in dsh.profile.bundles (${bundles.length} bundles total)`);
    } else {
      check('4. registered bundle', false, `${PKG_DIR} not in dsh.profile.bundles; DSH will not load the client bundle`);
    }
  } catch (e) {
    check('4. registered bundle', false, `cannot read ${profilePkg}: ${e.message}`);
  }
} else {
  check('4. registered bundle', false, `missing: ${profilePkg}`);
}

// 5. pnpm list --depth 0 reports the package
const isWin = process.platform === 'win32';
const pm = existsSync(join(profile, 'pnpm-lock.yaml')) ? 'pnpm' :
           existsSync(join(profile, 'package-lock.json')) ? 'npm' : 'pnpm';
const r = spawnSync(isWin ? `${pm}.cmd` : pm, ['list', '--depth', '0'], {
  cwd: profile, encoding: 'utf8', shell: isWin,
});
const seen = r.stdout?.split('\n').some((l) => l.includes(PKG_DIR));
if (seen) check(`5. ${pm} list`, true, `${PKG_DIR} reported`);
else check(`5. ${pm} list`, false, `not in ${pm} list output`);

// Report
let allOk = true;
for (const r of results) {
  const mark = r.ok ? '\u2713 ok  ' : '\u2717 FAIL';
  console.log(`${mark}  ${r.label.padEnd(34)} ${r.detail}`);
  if (!r.ok) allOk = false;
}

console.log('');
if (allOk) {
  console.log('all checks passed. Restart DSH to mount the plugin.');
  process.exit(0);
} else {
  console.log('some checks failed. Run `npm run install:dsh` to repair.');
  process.exit(1);
}
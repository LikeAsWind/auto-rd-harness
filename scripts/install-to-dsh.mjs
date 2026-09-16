#!/usr/bin/env node
/**
 * install-to-dsh — wire @yangzhitong/dsh-auto-rd into a local DSH profile.
 *
 * Idempotent. No external deps. Cross-platform (Windows / *nix).
 *
 * What it does:
 *   1. Resolves the target profile dir ($DSH_HOME/profiles or ~/.dsh/profiles,
 *      override with --profile).
 *   2. `pnpm add -C <profile> @yangzhitong/dsh-auto-rd@file:<repo>/packages/dsh-auto-rd`
 *      (npm/yarn auto-detected if pnpm is not used by the profile).
 *   3. Upserts a managed block inside <profile>/web/cordis.patch.yml:
 *      - Auto-RD entries are wrapped in clearly marked begin/end markers so
 *        re-runs and uninstall stay surgical. The block is the only thing
 *        the script writes between the markers; everything outside is
 *        preserved verbatim.
 *      - Tokens are referenced via `!js "process.env.<name> || ''"`; the
 *        script never contains, echoes, or rewrites any token value.
 *   4. Prints next steps (set env, restart DSH).
 *
 * Flags:
 *   --profile <dir>   override target profile dir
 *   --dry-run         print what would change; do not modify or install
 *   --uninstall       remove the auto-rd row + pnpm remove
 *   --help            usage
 *
 * Set these env vars BEFORE launching DSH (not before running this script):
 *   DSH_TAPD_API_TOKEN    TAPD user/token
 *   DSH_GITLAB_API_TOKEN  GitLab personal access token (api scope)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the absolute path of an executable on PATH. On Windows,
 * `spawnSync('pnpm', ...)` fails with ENOENT because Windows package
 * managers are usually `pnpm.cmd` / `pnpm.ps1` shims and Node refuses
 * to spawn them without a shell (CVE-2024-27980). Resolving to an
 * absolute path lets us spawn the shim directly without a shell, which
 * in turn keeps arguments (paths with spaces) intact.
 *
 * @returns absolute path to the executable, or null if not found.
 */
function locateOnPath(cmd) {
  const pathEnv = process.env.PATH || process.env.Path || process.env.path || '';
  const dirs = pathEnv.split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((s) => s.toLowerCase())
    : [''];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  return null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PKG_DIR = join(REPO_ROOT, 'packages', 'dsh-auto-rd');

const BLOCK_BEGIN = '# >>> auto-rd (managed by scripts/install-to-dsh.mjs) >>>';
const BLOCK_END   = '# <<< auto-rd <<<';

const HELP = `install-to-dsh — wire @yangzhitong/dsh-auto-rd into a local DSH profile

Usage:
  node scripts/install-to-dsh.mjs [--profile <dir>] [--dry-run] [--uninstall] [--help]

Defaults:
  profile   $DSH_HOME/profiles or ~/.dsh/profiles
  install   adds @yangzhitong/dsh-auto-rd via the profile's package manager
            and inserts a managed block in web/cordis.patch.yml
  uninstall removes the managed block and runs pnpm/npm/yarn remove

This script never sees or prints your tokens. Set these env vars in the
shell that launches DSH:
  DSH_TAPD_API_TOKEN, DSH_GITLAB_API_TOKEN`;

function parseArgs(argv) {
  const out = { profile: null, dryRun: false, uninstall: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

/**
 * DSH "profile" is a bundle directory like `~/.dsh/profiles/web/` — it owns
 * its own package.json (deps + scripts), its own node_modules, and the
 * cordis.patch.yml we need to edit. Resolve the bundle directly.
 */
function defaultProfileDir() {
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'profiles', 'web');
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('cannot resolve profile dir: set DSH_HOME or HOME/USERPROFILE');
  return join(home, '.dsh', 'profiles', 'web');
}

function ensureProfile(profileDir) {
  if (!existsSync(profileDir)) {
    throw new Error(`profile bundle dir not found: ${profileDir}\n` +
      `Set DSH_HOME or pass --profile <dir> (e.g. ~/.dsh/profiles/web).`);
  }
  if (!existsSync(join(profileDir, 'package.json'))) {
    throw new Error(`profile bundle ${profileDir} has no package.json — is DSH installed here?`);
  }
}

function run(cmd, args, opts = {}) {
  // Test seam: AUTORD_FAKE_PM=1 makes every package-manager call a no-op.
  // Used by scripts/test-install-to-dsh.mjs to exercise idempotency without
  // touching the real pnpm/npm/yarn.
  if (process.env.AUTORD_FAKE_PM === '1') {
    if (cmd === 'pnpm' || cmd === 'npm' || cmd === 'yarn') {
      return { status: 0, stdout: '', stderr: '' };
    }
  }
  const isWin = process.platform === 'win32';
  const isPm = cmd === 'pnpm' || cmd === 'npm' || cmd === 'yarn';
  // Windows: package-manager binaries (npm, pnpm, yarn) are .cmd shims.
  // Node refuses to spawn them without `shell: true` (CVE-2024-27980 →
  // EINVAL). Spawning them directly with `shell: true` ALSO fails
  // mysteriously (cmd-level crashes inside the shim). The reliable path
  // is: spawn cmd.exe (a real .exe, no CVE gate), pass the inner command
  // line as a single argv element, and let Node's `shell: true` handling
  // route the call through cmd.exe correctly. Empirically this is the
  // only combination that works on nvm-windows with Node ≥ 22.
  if (isWin && isPm) {
    // Wrap each argv element in `"..."` when it contains whitespace so
    // cmd does not split it. We do NOT add a defensive outer `"` pair
    // because cmd's "old behaviour" would strip it and we want this to
    // be a plain command line.
    const inner = [cmd, ...args]
      .map((a) => /\s/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a))
      .join(' ');
    const res = spawnSync('cmd.exe', ['/d', '/c', inner], {
      stdio: 'inherit',
      shell: true,
      ...opts,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`cmd.exe /d /c ${inner} exited ${res.status}`);
    }
    return res;
  }
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`);
  }
  return res;
}

function detectPackageManager(profileDir) {
  if (existsSync(join(profileDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(profileDir, 'package-lock.json'))) return 'npm';
  if (existsSync(join(profileDir, 'yarn.lock'))) return 'yarn';
  return 'pnpm'; // DSH profiles ship with pnpm.
}

/** Build the YAML body that goes between BLOCK_BEGIN / BLOCK_END. */
function buildBlockBody() {
  return [
    `- id: auto-rd`,
    `  name: '@yangzhitong/dsh-auto-rd'`,
    `  config:`,
    `    tapdBaseUrl: 'https://api.tapd.cn'`,
    `    tapdApiToken: !js "process.env.DSH_TAPD_API_TOKEN || ''"`,
    `    tapdPollIntervalMs: 60000`,
    `    tapdWorkspaceIds: []`,
    `    useTapdMock: false`,
    ``,
    `    gitlabBaseUrl: 'https://gitlab.com'`,
    `    gitlabApiToken: !js "process.env.DSH_GITLAB_API_TOKEN || ''"`,
    `    gitlabPushUserName: 'auto-rd'`,
    `    gitlabPushUserEmail: 'auto-rd@example.com'`,
    ``,
    `    workspaceRoot: 'C:/work'`,
    ``,
    `    modules: []`,
    ``,
    `    maxConcurrentStoriesPerModule: 1`,
    `    maxTotalConcurrentStories: 4`,
    ``,
    `    modelSelection:`,
    `      brainstorm: 'sonnet'`,
    `      critic: 'sonnet'`,
    `      decision: 'sonnet'`,
    `      spec: 'sonnet'`,
    `      planner: 'sonnet'`,
    `      implementation: 'haiku'`,
    `      test: 'sonnet'`,
    `      fix: 'sonnet'`,
    `      verification: 'sonnet'`,
    `      review: 'sonnet'`,
    `      finalVerify: 'opus'`,
    ``,
    `    logLevel: 'info'`,
  ].join('\n');
}

function buildManagedBlock() {
  return [BLOCK_BEGIN, buildBlockBody(), BLOCK_END].join('\n') + '\n';
}

function readPatch(patchFile) {
  if (!existsSync(patchFile)) return '';
  return readFileSync(patchFile, 'utf8');
}

/** Replace (or insert) the managed block, preserving everything outside. */
function upsertBlock(original) {
  const block = buildManagedBlock();
  const beginIdx = original.indexOf(BLOCK_BEGIN);
  const endIdx = original.indexOf(BLOCK_END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    // Replace existing block. Keep trailing newline after END if present.
    const afterEnd = original.slice(endIdx + BLOCK_END.length);
    return original.slice(0, beginIdx) + block + afterEnd.replace(/^\n/, '');
  }
  // Strip a stale top-level `[]` (an empty loader array left over from a
  // default patch.yml) so the resulting file is still a single top-level
  // YAML array — the managed block's first `- id:` line IS the array's
  // first element. Without this, the file would parse as two documents
  // and DSH's loader would reject it.
  let base = original
    .split('\n')
    .filter((l) => l.trim() !== '[]')
    .join('\n');
  // Ensure base ends with a newline, then add a blank line + block.
  if (!base.endsWith('\n')) base += '\n';
  if (base !== '') base += '\n';
  return base + block;
}

function removeBlock(original) {
  const beginIdx = original.indexOf(BLOCK_BEGIN);
  if (beginIdx < 0) return original;
  const endIdx = original.indexOf(BLOCK_END, beginIdx);
  if (endIdx < 0) throw new Error(`patch file has ${BLOCK_BEGIN} without ${BLOCK_END}`);
  // Slice out [begin, end] inclusive, plus the trailing newline.
  const endOfLine = original.indexOf('\n', endIdx);
  const cutEnd = endOfLine < 0 ? original.length : endOfLine + 1;
  const before = original.slice(0, beginIdx);
  const after = original.slice(cutEnd);
  // Trim a single separator newline that the append left behind.
  return before.replace(/\n+$/, '\n') + after.replace(/^\n+/, '');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  const profileDir = resolve(args.profile || defaultProfileDir());
  ensureProfile(profileDir);
  const patchFile = join(profileDir, 'cordis.patch.yml');
  mkdirSync(dirname(patchFile), { recursive: true });

  const pm = detectPackageManager(profileDir);

  if (args.uninstall) {
    const original = readPatch(patchFile);
    const after = removeBlock(original);
    if (after !== original) {
      if (!args.dryRun) writeFileSync(patchFile, after, 'utf8');
      process.stdout.write(`[uninstall] managed block removed from ${patchFile}\n`);
    } else {
      process.stdout.write(`[uninstall] no managed block present in ${patchFile}\n`);
    }
    if (!args.dryRun) {
      process.stdout.write(`[uninstall] ${pm} remove -C ${profileDir} @yangzhitong/dsh-auto-rd\n`);
      run(pm, ['remove', '-C', profileDir, '@yangzhitong/dsh-auto-rd']);
    } else {
      process.stdout.write(`(dry-run) would run: ${pm} remove -C ${profileDir} @yangzhitong/dsh-auto-rd\n`);
    }
    // Drop the local tarball cache (see install path) — it's safe to
    // remove even if pnpm didn't actually unpack it.
    const cacheDir = join(profileDir, 'node_modules', '.cache', 'autord-install');
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
      process.stdout.write(`[uninstall] removed local tarball cache: ${cacheDir}\n`);
    }
    process.stdout.write('Done. Restart DSH to pick up the change.\n');
    return;
  }

  // Pack the local plugin into a tarball so we don't have to pass an
// `@file:` specifier through cmd.exe — `@` is a reserved character in
// cmd's `/c` mode, and `pnpm add <path>` accepts a plain path. We use
// `npm pack` because (a) npm is bundled with Node so no extra dep, and
// (b) it accepts the same `<directory>` form via cwd that pnpm does.
const cacheDir = join(profileDir, 'node_modules', '.cache', 'autord-install');
mkdirSync(cacheDir, { recursive: true });
const tarball = join(cacheDir, 'dsh-auto-rd.tgz');
process.stdout.write(`[1/4] npm pack ${PKG_DIR} -> ${tarball}\n`);
// `npm pack` writes `dsh-auto-rd-<version>.tgz` to the destination;
// we use `--silent` so only errors surface.
run('npm', ['pack', PKG_DIR, '--pack-destination', cacheDir, '--silent']);

// `npm pack` writes the tarball to `<destination>` with the package's
// scoped name as a prefix (`<scope>-<name>-<version>.tgz`).
const produced = readdirSync(cacheDir).find((f) => /\.tgz$/.test(f) && /dsh-auto-rd-/.test(f)) || (existsSync(tarball) ? 'dsh-auto-rd.tgz' : null);
if (!produced) throw new Error(`npm pack produced no tarball in ${cacheDir}`);
if (produced !== 'dsh-auto-rd.tgz') {
  renameSync(join(cacheDir, produced), tarball);
}

if (!args.dryRun) {
  process.stdout.write(`[2/4] ${pm} add -C ${profileDir} ${tarball}\n`);
  run(pm, ['add', '-C', profileDir, tarball]);
} else {
  process.stdout.write(`(dry-run) would run: ${pm} add -C ${profileDir} ${tarball}\n`);
}

  // Patch
  const original = readPatch(patchFile);
  const updated = upsertBlock(original);
  if (updated === original) {
    process.stdout.write(`[3/4] managed block already present in ${patchFile} — left unchanged\n`);
  } else if (!args.dryRun) {
    writeFileSync(patchFile, updated, 'utf8');
    process.stdout.write(`[3/4] managed block upserted in ${patchFile}\n`);
  } else {
    process.stdout.write(`[3/4] (dry-run) would upsert managed block in ${patchFile}\n`);
    process.stdout.write('--- block to be inserted ---\n');
    process.stdout.write(buildManagedBlock());
    process.stdout.write('--- end ---\n');
  }

  // Next steps
  process.stdout.write(`[4/4] Next steps:\n`);
  process.stdout.write(`       set DSH_TAPD_API_TOKEN   and  DSH_GITLAB_API_TOKEN in the shell that launches DSH\n`);
  process.stdout.write(`       (this script never reads them; they are referenced by name in the patch)\n`);
  process.stdout.write(`       restart DSH\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`install-to-dsh: ${e.message}\n`);
  process.exit(1);
}
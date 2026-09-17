#!/usr/bin/env node
/**
 * install-to-dsh — wire @yangzhitong/dsh-auto-rd into a local DSH profile.
 *
 * Idempotent. No external deps. Cross-platform (Windows / *nix).
 *
 * What it does (a real, standard DSH install — see
 * https://github.com/deepseek-ai/dsh for the loader / bundle contract):
 *   1. Resolves the target profile dir ($DSH_HOME/profiles or ~/.dsh/profiles,
 *      override with --profile).
 *   2. Builds and packs the local plugin into a tarball so we don't have
 *      to pass an `@file:` specifier through cmd.exe (@ is reserved in
 *      cmd's /c mode); `pnpm add <path>` accepts a plain path.
 *   3. `pnpm add -C <profile> @yangzhitong/dsh-auto-rd@file:<tarball>`
 *      (npm/yarn auto-detected if pnpm is not used by the profile).
 *   4. Registers the bundle in `<profile>/package.json` under
 *      `dsh.profile.bundles` so DSH's loader resolves the host plugin
 *      `lib/index.js` AND the web shell loads `lib/client.js`.
 *   5. Writes / updates a managed block in `<profile>/cordis.patch.yml`:
 *         - id: auto-rd
 *           name: '@yangzhitong/dsh-auto-rd'
 *           config: <default config from packages/dsh-auto-rd/cordis.patch.yml>
 *      This is the entry DSH's loader activates at startup; without it
 *      the bundle is in `node_modules` but never mounted.
 *   6. Prints next steps (set env, restart DSH).
 *
 * Tokens are never touched by this script — DSH reads them from the
 * launching shell's env. Users who want non-default config write their
 * overrides into `<profile>/cordis.patch.yml`, which DSH applies AFTER
 * the bundle's own `cordis.patch.yml` so user values win.
 *
 * Flags:
 *   --profile <dir>   override target profile dir
 *   --dry-run         print what would change; do not modify or install
 *   --uninstall       remove the bundle + pnpm remove
 *   --help            usage
 *
 * Set these env vars BEFORE launching DSH (not before running this script):
 *   DSH_TAPD_API_TOKEN    TAPD user/token
 *   DSH_GITLAB_API_TOKEN  GitLab personal access token (api scope)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, renameSync, copyFileSync } from 'node:fs';
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
const PKG_JSON = join(PKG_DIR, 'package.json');
const PLUGIN_PATCH = join(PKG_DIR, 'cordis.patch.yml');

const BUNDLE_NAME = '@yangzhitong/dsh-auto-rd';
const BLOCK_BEGIN = '# >>> auto-rd (managed by scripts/install-to-dsh.mjs) >>>';
const BLOCK_END   = '# <<< auto-rd <<<';

const HELP = `install-to-dsh — wire @yangzhitong/dsh-auto-rd into a local DSH profile

Usage:
  node scripts/install-to-dsh.mjs [--profile <dir>] [--dry-run] [--uninstall] [--help]

Defaults:
  profile   $DSH_HOME/profiles or ~/.dsh/profiles
  install   adds @yangzhitong/dsh-auto-rd via the profile's package manager
            and registers it under package.json#dsh.profile.bundles
  uninstall removes the bundle from dsh.profile.bundles and runs pnpm/npm/yarn remove
            (also strips a legacy managed block from cordis.patch.yml if present)

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
 * cordis.patch.yml we may need to clean up on uninstall.
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

/**
 * Read the profile's package.json and return it parsed. We deliberately
 * keep the in-memory shape rather than re-stringifying from scratch: the
 * script should preserve every unrelated field, ordering, and formatting
 * that npm/pnpm/DSH wrote into it.
 */
function readProfilePkg(profileDir) {
  const path = join(profileDir, 'package.json');
  const raw = readFileSync(path, 'utf8');
  return { path, raw, parsed: JSON.parse(raw) };
}

/**
 * Add @yangzhitong/dsh-auto-rd to dsh.profile.bundles (creating the path
 * if missing). Idempotent: a no-op when the bundle is already listed.
 * Returns "added" | "already-present".
 */
function registerBundle(pkg, bundleName) {
  const dsh = pkg.dsh || (pkg.dsh = {});
  const profile = dsh.profile || (dsh.profile = {});
  const bundles = Array.isArray(profile.bundles) ? profile.bundles.slice() : [];
  if (bundles.includes(bundleName)) return { bundles, changed: false };
  bundles.push(bundleName);
  profile.bundles = bundles;
  return { bundles, changed: true };
}

/**
 * Remove @yangzhitong/dsh-auto-rd from dsh.profile.bundles. Returns
 * "removed" | "not-present".
 */
function unregisterBundle(pkg, bundleName) {
  const bundles = pkg.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) return { bundles: undefined, changed: false };
  const next = bundles.filter((b) => b !== bundleName);
  const changed = next.length !== bundles.length;
  pkg.dsh.profile.bundles = next;
  return { bundles: next, changed };
}

function writeProfilePkg(pkgCtx) {
  // Use 2-space indent + trailing newline to match what npm/pnpm write.
  writeFileSync(pkgCtx.path, JSON.stringify(pkgCtx.parsed, null, 2) + '\n', 'utf8');
}

/**
 * Legacy managed block support — the previous install version wrote a
 * user-level overlay block into cordis.patch.yml. New installs go
 * through package.json#dsh.profile.bundles instead, but we still strip
 * a leftover block on uninstall so a re-install cycle stays clean.
 */
function readPatch(patchFile) {
  if (!existsSync(patchFile)) return '';
  return readFileSync(patchFile, 'utf8');
}

function removeLegacyBlock(original) {
  const beginIdx = original.indexOf(BLOCK_BEGIN);
  if (beginIdx < 0) return { text: original, removed: false };
  const endIdx = original.indexOf(BLOCK_END, beginIdx);
  if (endIdx < 0) throw new Error(`patch file has ${BLOCK_BEGIN} without ${BLOCK_END}`);
  const endOfLine = original.indexOf('\n', endIdx);
  const cutEnd = endOfLine < 0 ? original.length : endOfLine + 1;
  const before = original.slice(0, beginIdx);
  const after = original.slice(cutEnd);
  const text = before.replace(/\n+$/, '\n') + after.replace(/^\n+/, '');
  return { text, removed: true };
}

/**
 * Build the plugin before installing. We need `lib/` (and the
 * `lib/client.js` copy) so that `npm pack` produces a tarball that the
 * profile loader can actually require.
 *
 * The build is just `tsc` + the two copy scripts defined in
 * `packages/dsh-auto-rd/package.json#scripts`. We invoke them through
 * `npm run --prefix` so we don't have to write a separate build driver.
 */
function buildPlugin() {
  process.stdout.write(`[build] npm run build --prefix ${PKG_DIR}\n`);
  run('npm', ['run', '--prefix', PKG_DIR, 'build']);
}

/**
 * Read the plugin's `cordis.patch.yml` (the canonical bundle-owned
 * patch — see package.json#dsh.bundle.patch) and render a USER-OVERLAY
 * entry suitable for `<profile>/cordis.patch.yml`.
 *
 * The bundle's own file uses DSH's `insert` form (`- insert:` with no
 * top-level id) so the loader creates a fresh entry on bundle load.
 * The user's overlay MUST use the patch form (`- id: ...` + config:)
 * instead, so it modifies the bundle-inserted entry's config rather
 * than inserting a second `auto-rd` entry (which the loader would keep
 * as a duplicate).
 *
 * We therefore:
 *   1. Strip leading comment lines.
 *   2. Find the `- insert:` line.
 *   3. Drop the `- insert:` wrapper and dedent the inner list by the
 *      indent that wrapped it (2 spaces in our shipped file), so the
 *      entry becomes a top-level `- id: ...` row in the overlay.
 *
 * NOTE: this is the only transformation we do — keys and values are
 * preserved byte-for-byte. `cordis.patch.yml` is the source of truth.
 */
function renderPluginEntry() {
  const patchText = readFileSync(PLUGIN_PATCH, 'utf8');
  const lines = patchText.split(/\r?\n/);
  const insertIdx = lines.findIndex((l) => /^\s*-\s+insert:/.test(l));
  if (insertIdx < 0) throw new Error(`could not find loader entry (- insert: ...) in ${PLUGIN_PATCH}`);
  // Find the indent applied to the inner `- id:` row.
  const innerMatch = lines[insertIdx + 1]?.match(/^(\s+)-\s/);
  if (!innerMatch) throw new Error(`malformed - insert: block in ${PLUGIN_PATCH}: no inner entry on the next line`);
  const innerIndent = innerMatch[1];
  // Drop everything up to and including the `- insert:` line, then
  // dedent the remainder by the inner indent so the entry becomes
  // top-level. Strip trailing blank lines.
  const entryLines = lines.slice(insertIdx + 1).map((l) =>
    l.startsWith(innerIndent) ? l.slice(innerIndent.length) : l
  );
  while (entryLines.length > 0 && entryLines[entryLines.length - 1].trim() === '') {
    entryLines.pop();
  }
  return entryLines.join('\n');
}

/**
 * Upsert (insert or replace) the managed block in the profile's
 * cordis.patch.yml. Idempotent: a second run replaces the previous block
 * with the freshly rendered default config.
 */
function upsertManagedBlock(original, entryYaml) {
  const blockBody = [
    BLOCK_BEGIN,
    entryYaml,
    BLOCK_END,
  ].join('\n');

  const beginIdx = original.indexOf(BLOCK_BEGIN);
  if (beginIdx < 0) {
    // No block yet — append it. A leading newline makes it readable
    // when the file already ends without one.
    const sep = original.length > 0 && !original.endsWith('\n') ? '\n' : '';
    const text = original.replace(/\s*$/, '') + sep + '\n' + blockBody + '\n';
    return { text, changed: true, action: 'inserted' };
  }
  const endIdx = original.indexOf(BLOCK_END, beginIdx);
  if (endIdx < 0) throw new Error(`patch file has ${BLOCK_BEGIN} without ${BLOCK_END}`);
  const endOfLine = original.indexOf('\n', endIdx);
  const cutEnd = endOfLine < 0 ? original.length : endOfLine + 1;
  const before = original.slice(0, beginIdx);
  const after = original.slice(cutEnd);
  const text = before.replace(/\n+$/, '\n') + blockBody + '\n' + after.replace(/^\n+/, '');
  return { text, changed: true, action: 'replaced' };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  const profileDir = resolve(args.profile || defaultProfileDir());
  ensureProfile(profileDir);

  const pm = detectPackageManager(profileDir);

  if (args.uninstall) {
    // 1. Drop a legacy managed block from cordis.patch.yml if present.
    const patchFile = join(profileDir, 'cordis.patch.yml');
    const original = readPatch(patchFile);
    if (original) {
      const { text, removed } = removeLegacyBlock(original);
      if (removed) {
        if (!args.dryRun) writeFileSync(patchFile, text, 'utf8');
        process.stdout.write(`[uninstall] legacy managed block removed from ${patchFile}\n`);
      } else {
        process.stdout.write(`[uninstall] no legacy managed block in ${patchFile}\n`);
      }
    }

    // 2. Remove the bundle from package.json#dsh.profile.bundles.
    const pkgCtx = readProfilePkg(profileDir);
    const { changed } = unregisterBundle(pkgCtx.parsed, BUNDLE_NAME);
    if (changed) {
      if (!args.dryRun) writeProfilePkg(pkgCtx);
      process.stdout.write(`[uninstall] removed ${BUNDLE_NAME} from dsh.profile.bundles in ${pkgCtx.path}\n`);
    } else {
      process.stdout.write(`[uninstall] ${BUNDLE_NAME} was not in dsh.profile.bundles — left unchanged\n`);
    }

    // 3. pnpm/npm/yarn remove
    if (!args.dryRun) {
      process.stdout.write(`[uninstall] ${pm} remove -C ${profileDir} ${BUNDLE_NAME}\n`);
      run(pm, ['remove', '-C', profileDir, BUNDLE_NAME]);
    } else {
      process.stdout.write(`(dry-run) would run: ${pm} remove -C ${profileDir} ${BUNDLE_NAME}\n`);
    }

    // 4. Drop the local tarball cache (see install path) — it's safe to
    //    remove even if pnpm didn't actually unpack it.
    const cacheDir = join(profileDir, 'node_modules', '.cache', 'autord-install');
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
      process.stdout.write(`[uninstall] removed local tarball cache: ${cacheDir}\n`);

      process.stdout.write('Done. Restart DSH to pick up the change.\n');
    }

    process.stdout.write('Done. Restart DSH to pick up the change.\n');
    return;
  }

  // 0. Build the plugin so that `lib/` (and `lib/client.js`) are fresh.
  // We do this in dry-run too — building is read-only w.r.t. the profile.
  if (!args.dryRun) {
    buildPlugin();
  } else {
    process.stdout.write(`(dry-run) would run: npm run build --prefix ${PKG_DIR}\n`);
  }

  // 1. Pack the local plugin into a tarball so we don't have to pass an
  // `@file:` specifier through cmd.exe — `@` is a reserved character in
  // cmd's `/c` mode, and `pnpm add <path>` accepts a plain path. We use
  // `npm pack` because (a) npm is bundled with Node so no extra dep, and
  // (b) it accepts the same `<directory>` form via cwd that pnpm does.
  const cacheDir = join(profileDir, 'node_modules', '.cache', 'autord-install');
  mkdirSync(cacheDir, { recursive: true });
  const tarball = join(cacheDir, 'dsh-auto-rd.tgz');
  process.stdout.write(`[1/5] npm pack ${PKG_DIR} -> ${tarball}\n`);
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
    process.stdout.write(`[2/5] ${pm} add -C ${profileDir} ${tarball}\n`);
    run(pm, ['add', '-C', profileDir, tarball]);
  } else {
    process.stdout.write(`(dry-run) would run: ${pm} add -C ${profileDir} ${tarball}\n`);
  }

  // 2b. Force-copy the freshly built artefacts into the installed package.
  //
  // Why this is needed: `pnpm add <tarball>` reuses the existing on-disk
  // install via the content-addressable store when the dependency's
  // declared version is unchanged, and does not refresh the file
  // contents inside node_modules/<scope>/<name>/lib/. So a build that
  // changed src/client/client.js (the panel body) but did not bump the
  // version leaves DSH running the stale bundle — and the user sees
  // React errors that have already been fixed in src.
  //
  // Copy every artefact `package.json#files` ships (lib/, plus the
  // three top-level config files) byte-for-byte from PKG_DIR into
  // node_modules/<bundle>. PKG_DIR is the source of truth: it was the
  // input to `npm pack` one step earlier, so its contents match what
  // the user just built.
  if (!args.dryRun) {
    const installedDir = join(profileDir, 'node_modules', BUNDLE_NAME);
    if (existsSync(installedDir)) {
      // Force-copy one file from PKG_DIR/<rel> into installedDir/<rel>.
      const forceCopyFile = (rel) => {
        const src = join(PKG_DIR, rel);
        const dst = join(installedDir, rel);
        if (!existsSync(src)) return;
        copyFileSync(src, dst);
      };
      // Force-copy a directory tree from PKG_DIR/<rel> into
      // installedDir/<rel>, replacing whatever was there. Implemented
      // in Node (not via cp/xcopy/robocopy) because Windows shell
      // quoting around paths with spaces makes spawning the system
      // tools unreliable from Git Bash / cmd.exe.
      const forceCopyTree = (rel) => {
        const src = join(PKG_DIR, rel);
        const dst = join(installedDir, rel);
        if (!existsSync(src)) return;
        mkdirSync(dst, { recursive: true });
        const copyRecursive = (s, d) => {
          for (const entry of readdirSync(s, { withFileTypes: true })) {
            const sp = join(s, entry.name);
            const dp = join(d, entry.name);
            if (entry.isDirectory()) {
              mkdirSync(dp, { recursive: true });
              copyRecursive(sp, dp);
            } else if (entry.isFile()) {
              copyFileSync(sp, dp);
            }
          }
        };
        copyRecursive(src, dst);
      };
      // Force-copy everything `package.json#files` ships: the whole
      // `lib/` tree plus three top-level config files. Copying the tree
      // (rather than enumerating subdirs) means any newly-added source
      // file — e.g. a new lib/domain/credentials.js — lands in the
      // installed bundle even when pnpm reuses a cached install without
      // bumping the version.
      forceCopyFile('cordis.patch.yml');
      forceCopyFile('dsh.plugin.json');
      forceCopyFile('package.json');
      forceCopyTree('lib');
      process.stdout.write(`[2b/5] force-refreshed ${BUNDLE_NAME} from the freshly built sources\n`);
    }
  }

  // 3. Register the bundle so DSH's loader resolves the host plugin AND
  // the web shell picks up the client bundle.
  const pkgCtx = readProfilePkg(profileDir);
  const { changed } = registerBundle(pkgCtx.parsed, BUNDLE_NAME);
  if (changed) {
    if (!args.dryRun) writeProfilePkg(pkgCtx);
    process.stdout.write(`[3/5] registered ${BUNDLE_NAME} in dsh.profile.bundles\n`);
  } else {
    process.stdout.write(`[3/5] ${BUNDLE_NAME} already in dsh.profile.bundles — left unchanged\n`);
  }

  // 4. Write the managed entry into the profile's `cordis.patch.yml`.
  // This is the actual loader entry; without it the bundle is in
  // `node_modules` but never mounted by DSH's activation graph.
  const patchFile = join(profileDir, 'cordis.patch.yml');
  const original = readPatch(patchFile);
  const entryYaml = renderPluginEntry();
  const { text: newPatch, action } = upsertManagedBlock(original, entryYaml);
  if (newPatch !== original) {
    if (!args.dryRun) writeFileSync(patchFile, newPatch, 'utf8');
    process.stdout.write(`[4/5] ${action} managed block in ${patchFile}\n`);
  } else {
    process.stdout.write(`[4/5] managed block already up to date in ${patchFile}\n`);
  }

  // Next steps
  process.stdout.write(`[5/5] Next steps:\n`);
  process.stdout.write(`       edit ${patchFile} to set tapdApiToken, gitlabApiToken, modules:\n`);
  process.stdout.write(`       (defaults are wired; tokens stay in the launching shell's env:\n`);
  process.stdout.write(`        DSH_TAPD_API_TOKEN / DSH_GITLAB_API_TOKEN)\n`);
  process.stdout.write(`       restart DSH\n`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`install-to-dsh: ${e.message}\n`);
  process.exit(1);
}

# Credentials — TAPD & GitLab tokens

> **TL;DR.** auto-rd does **not** store TAPD or GitLab API tokens in
> `cordis.patch.yml`, in `~/.dsh/storage/auto-rd/`, or anywhere else on
> disk. All token values live in **`~/.dsh/.credentials.yaml`**, which
> DSH manages through `ctx.credentials`. Plugin config holds *reference
> names* (env-var identifiers like `DSH_TAPD_API_TOKEN`); the runtime
> resolves them through the credentials seam on every fetch.

This matches how DSH's own control-panel keys (`DEEPSEEK_API_KEY` etc.)
already work. See [issue #10](https://github.com/LikeAsWind/auto-rd-harness/issues/10).

---

## Why references, not values

- **Disk safety.** Plaintext tokens in a YAML file are discoverable
  via grep, accidentally pushed to git, and reproduced in backups.
- **Rotation.** Changing a key is a one-line edit in
  `~/.dsh/.credentials.yaml` (or an `export` in the launching shell),
  not a plugin config edit that would trigger a reconfigure round-trip.
- **Multi-machine.** The same patch tree ships to every developer /
  CI runner; only the credentials file diverges per environment.
- **Env override.** The launching shell can shadow any stored value
  with an env var — handy for CI and for quick "is this key the
  problem?" debugging without editing the credentials file.

## Reference names in use

| Reference                              | Resolved by                              |
| -------------------------------------- | ---------------------------------------- |
| `DSH_TAPD_API_TOKEN`                   | TAPD poller, story sync                  |
| `DSH_GITLAB_API_TOKEN`                 | MR creation                              |
| `DSH_TAPD_API_TOKEN_FOR_<MODULE_ID>`   | TAPD poller for `<MODULE_ID>` (override) |
| `DSH_GITLAB_API_TOKEN_FOR_<MODULE_ID>` | MR creation for `<MODULE_ID>` (override) |

`<MODULE_ID>` is uppercased and any non-`[A-Z0-9_]` character is
collapsed to an underscore. So `yc-sale-control-server` becomes
`DSH_TAPD_API_TOKEN_FOR_YC_SALE_CONTROL_SERVER`.

## Resolution order

The poller / runner ask for a token with `resolveTapdToken` /
`resolveGitlabToken`. The plugin walks the cascade:

1. **Per-module ref** (`DSH_<X>_API_TOKEN_FOR_<MODULE_ID>`)
2. **Global ref** (`DSH_TAPD_API_TOKEN` / `DSH_GITLAB_API_TOKEN`)
3. **Miss → caller decides.** The TAPD poller falls through to mock
   mode when the global is empty (and `useTapdMock` is not
   `false`); MR creation surfaces a 401 / token-missing error.

Inside step 1 / 2, DSH's own `ctx.credentials.resolve` looks at:

- the launching shell's `DSH_TAPD_API_TOKEN` env var (case-sensitive;
  the credentials file overrides the env when both are set)
- `~/.dsh/.credentials.yaml#refs.DSH_TAPD_API_TOKEN`

See [DSH credentials docs](https://github.com/deepseek-ai/dsh) for the
authoritative precedence.

## Setting tokens

### Option 1 — DSH control panel

Open `Settings → Bundles → @yangzhitong/dsh-auto-rd → Configure
workspaces`. Each workspace row has a `tapdToken` / `gitlabToken`
field. Saving routes the value through `credentials.set` and rewrites
the field on disk to the ref name — the value is never written to
storage.

### Option 2 — Edit `~/.dsh/.credentials.yaml` directly

```yaml
refs:
  DSH_TAPD_API_TOKEN: tapd_personal_access_token_value
  DSH_GITLAB_API_TOKEN: glpat-xxxxxxxxxxxxxxxxxxxx
  DSH_TAPD_API_TOKEN_FOR_YC_SALE_CONTROL_SERVER: tapd_personal_access_token_value
  DSH_GITLAB_API_TOKEN_FOR_YC_SALE_CONTROL_SERVER: glpat-yyyyyyyyyyyyyyyyyyyy
```

The file is mode 0600 by default (DSH enforces this on first write).
Run `npm run install:dsh` once before the file appears, then set the
keys and restart DSH.

### Option 3 — Env var override

For one-off debugging or for CI runners, set the env var in the
shell that launches DSH:

```powershell
$env:DSH_TAPD_API_TOKEN = "tapd_personal_access_token_value"
$env:DSH_GITLAB_API_TOKEN = "glpat-xxxxxxxxxxxxxxxxxxxx"
npx dsh web
```

Env values are read every time the poller / runner resolves, so
updating them does not require a restart of DSH itself — only a
restart of the *child process* that owns the env (which is the
DSH server). DSH re-reads the env on launch; to pick up new env
values without a full restart, re-export and re-mount the plugin.

> **Env vs file precedence.** The credentials file wins over the env
> when both have a value. Use env for transient overrides, the file
> for permanent storage.

## Migration from plaintext

If you installed auto-rd before issue #10 closed, your storage may
still hold literal tokens in `modules/<id>.json` and in the
`tapdApiToken` / `gitlabApiToken` fields of `cordis.patch.yml`. The
plugin runs a one-shot migration on mount:

1. For each module with a non-ref-name value, the literal is written
   into `~/.dsh/.credentials.yaml` under
   `DSH_<X>_API_TOKEN_FOR_<MODULE_ID>` and the module field is
   rewritten to that ref name.
2. The same is done for the global fields (under `DSH_TAPD_API_TOKEN`
   / `DSH_GITLAB_API_TOKEN`).
3. The migration is idempotent — re-running it on already-migrated
   data is a no-op.
4. The migration is best-effort — a `credentials.set` rejection
   (e.g. read-only provider) is logged and skipped; the plaintext
   is left in place so you can manually move it.

Each successful rewrite is logged as a `warn` line carrying the ref
name and the value's length, **never the value itself**:

```
[auto-rd] [migrate] module yc-sale-control-server: tapdApiToken migrated plaintext -> DSH_TAPD_API_TOKEN_FOR_YC_SALE_CONTROL_SERVER (value length=40)
```

## Security notes

- **Plugin config carries ref names only.** A leaked `cordis.patch.yml`
  gives an attacker no token values.
- **Panel payloads are value-free.** The `/auto-rd/panel` JSON model
  reports `tapdTokenConfigured: true|false`, never the token.
- **Audit logs are value-free.** Migration lines and resolution
  traces include the ref name and the value's length; the value
  itself is never written to logs. This is enforced by the
  `formatTokenResolution` helper and asserted in
  `scripts/test-credentials.mjs`.
- **Per-module refs are not reversible.** Given a ref like
  `DSH_TAPD_API_TOKEN_FOR_YC_SALE_CONTROL_SERVER` you cannot
  reconstruct the original module id (`team.subteam.project` and
  `team-subteam.project` collapse to the same ref). The plugin
  resolves forward (id → ref) and never backward.
- **Empty values are not "configured".** A ref set to `""` is treated
  as missing so the cascade falls through to the global ref. This
  prevents a user accidentally clearing their TAPD key by saving an
  empty workspace field.

## Troubleshooting

| Symptom                                             | Likely cause                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Panel says "tapd_token" setup-required even with a key set | The value lives at a ref the poller doesn't know about (typo / extra space). Run `dsh credentials describe DSH_TAPD_API_TOKEN` to confirm. |
| Poller running against the mock fixture unexpectedly | The global ref is unset *and* no module has a per-module override. Set `DSH_TAPD_API_TOKEN` or set `useTapdMock: false` explicitly to surface the gap. |
| `credential_write_rejected` on save                 | The credentials service is read-only in the current profile (e.g. CI). Set the value via env var or via the credentials file directly. |
| Migration log shows `[migrate] no credentials service mounted` | The DSH profile doesn't include `dsh-credentials-local`. Install it via `npm i dsh-credentials-local` in your profile directory. |
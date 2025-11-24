I would like to split the `save` command into two separate commands: `save` and `pack`, **but both should use the same “full copy into local registry” model** (no special link-only WIP layout).

For `save` command:
- Perform platform sync (same as current `save`).
- Compute the next WIP version (see `save-pack-versioning.md`).
- **Copy the entire package** from `.openpackage/packages/<pkg>` into the local registry under the computed WIP version (same copy logic as existing `save --stable` / `pack`).
- On each save, remove older WIP versions for the same workspace (per `workspaceHash`) to keep the registry clean.
- Prefer not to update the `package.yml` version number; instead, keep WIP/stable details in `package.index.yml` and registry metadata.
- The `save` command always saves the next prerelease version based on the current stable (for example: `1.0.0` then `1.0.1-000fz8.a3k`, `1.0.1-000fz9.a3k`, `1.0.1-000fza.a3k`).

For `pack` command:
- This is essentially the same as “promote current workspace state to a stable version”.
- The stable version is basically the current workspace version with the prerelease tag removed (the base `package.yml.version`).
- **Copy the entire package** from `.openpackage/packages/<pkg>` into the local registry under the stable version (use the same copy logic as for `save` WIP copies).

### Implementation Plan: Split `save` → `save` (WIP Pointer) + `pack` (Stable Copy)

This plan refactors the existing `save` command into two orthogonal ones, minimizing disruption:
- **`save <pkg>`**: Create a WIP prerelease version by copying the full package into the registry (auto-next prerelease).
- **`pack <pkg>`**: Full stable copy (reuse ~90% existing copy logic, strip prerelease).

**Goals Achieved**:
- `save`: Fast iterative dev (sync + full copy), per-workspace cleanup, minimal version coupling.
- `pack`: "Promote" to stable (copy snapshot).
- Versioning: Auto-bump PATCH on first WIP from stable base; subsequent WIP reuse base.
- No staging `package.yml` mutation (per pref—version in registry metadata only).
- Registry layout is unified: **both WIP and stable versions are stored as full copies** under `~/.openpackage/registry/<pkg>/<version>/...`.

**Assumptions** (based on codebase snapshot):
- Pkg staging: `<cwd>/.openpackage/packages/<pkg>/` (files + `package.yml` w/ base version).
- Registry: `~/.openpackage/registry/<pkg>/<full-version>/` (dirs w/ files/index.yml).
- Existing `save.ts`: Orchestrates sync → version gen → copy → yml.
- wsHash: 8-char SHA256(cwd) via `hash-utils.ts`.
- ts: 6-char base36 epoch sec pad via new util.
- Commands auto-detect `<pkg>` via context/discovery if omitted.

**Migration**:
- Remove `save stable`, now favor `pack`.
- `save` now always WIP.

### Questions for Clarification
1. **Base version source/target**:
   - Where read base for `save` bump? Staging `package.yml`? Registry latest stable? User arg?
   - Confirm: Staging `package.yml` stays unchanged (e.g., always `1.0.0`), full WIP only in registry `index.yml`?
2. **Platform sync details**: What does "platform sync" entail exactly? Run `platform-sync.ts` + `root-files-sync.ts` always pre-save/pack? Any pkg-specific?
3. **Local staging after save**: Keep files at `packages/<pkg>` (source for full copy), no special renaming needed.
4. **Current save bumps?**: Does existing `save` auto-bump versions (how)? Bump minor/patch? Need to read `save/package-yml-versioning.ts`?
5. **Pack cleanup**: Auto-rm this WS's WIP on pack? Or flag?
6. **CLI syntax**: `save [pkg]` (infer from cwd)? `save --base 1.0.1`? `pack --force`?
7. **WIP promotion**: Typical flow `save` → iterate → `pack`? Any `save --pack` shortcut?
8. **Multi-pkg**: Commands handle one `<pkg>` or all?
9. **Errors**: If registry copy is corrupted on install, fallback to what? (Registry copies should be self-contained.)
10. **wsHash precision**: 8 chars enough (1-in-10^15 collision)? Full SHA if paranoid.

Feedback:
- Completely remove `save --stable` stable option, no backwards compatability, `pack` command onwards
Clarification:
1. Read base for save bump using staging ws .openpackage/packages/<pkg>/package.yml. There is an existing .openpackage/packages/<pkg>/package.index.yml file with version and files fields. For WIP builds, package.yml version will always show base version, the package.index.yml version will show/be updated to exact version, whether stable or wip.
2. Please take a look at the current implementation of save.ts, it should include both platform-sync and root-files-sync. Basically any existing functionality should remain intact, and be used for both save and pack, only changes are the ones I mentioned explicitly.
3. Keep files at `packages/<pkg>` after save, no changes
4. Current save performs auto bumping to wip on saves, should be pretty much the same except with new prerelease timestamp and ws stamps. Please read save.ts related files
5. Yes, auto clean up after pack, rm the WS's WIP on pack
6. Yes perform save [pkg], no save --base, pretty much use existing. Yes to implementing `pack --force` option.
7. No `save --pack` shortcut, since `pack` should already do everything save does but more, keep distinct
8. One <pkg> per command (in general, keep as close to current implementation as possible except for specifically mentioned changes)
9. Let's focus on save and pack commands ONLY for now, it's ok if install breaks, we will work on it next in a different batch/session
10. 8 chars is enough for now, I may even shorten it (not expecting a lot of workspaces on single machine)
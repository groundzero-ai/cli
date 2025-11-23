### Install Command – Stage 2 Plan: Version Resolution & Canonical Behavior

This plan defines the second implementation stage for the new `install` behavior, focused on:

- **Version resolution** (local+remote, WIP vs stable, and new `--local` behavior).
- **`package.yml` as canonical** for direct dependencies.
- **CLI vs canonical reconciliation** for `opkg install <name>` and `<name>@<spec>`.

Refer to:
- `../install-behavior.md`
- `../package-yml-canonical.md`
- `../version-resolution.md`

---

### 1. Goals for Stage 2

- **G1 – Implement “latest in range from local+remote”**:
  - For any effective version constraint, deterministically select the **highest semver** version satisfying it, using:
    - **Union of local + remote versions** in default mode.
    - **Remote-only** versions when `--remote` is set.
    - **Local-only** versions when `--local` is set.
- **G2 – Enforce `package.yml` as canonical**:
  - `install`:
    - **Reads** existing ranges from `.openpackage/package.yml`.
    - **Adds** new entries for fresh dependencies.
    - **Never rewrites** existing version ranges for direct dependencies.
- **G3 – Clarify CLI vs `package.yml` semantics**:
  - Implement the fresh/existing dependency behaviors from `install-behavior.md` and `package-yml-canonical.md`.
  - Handle mismatched CLI specs (`foo@2.0.0` vs `foo: ^1.2.0`) as **hard errors** with clear guidance.
 - **G4 – Implement WIP content resolution via `package.link.yml`**:
  - When a selected local WIP version is represented only by a link file (`package.link.yml`), install must:
    - Load package contents from the linked `sourcePath` instead of expecting a full copied registry tree.
    - Fail clearly if the link is missing or invalid.

---

### 2. Resolution Modes & Data Sources

Use the `InstallResolutionMode` established in Stage 1 (`'default' | 'remote-primary' | 'local-only'`) to drive data-source behavior inside the resolver.

#### 2.1 Default mode (`mode = 'default'`)

- **Version sources**:
  - Attempt to gather:
    - **Local versions** via `listPackageVersions(name)`.
    - **Remote versions** via registry metadata (`fetchRemotePackageMetadata` or equivalent).
  - Compute:
    - `available = dedup(local ∪ remote)` (see `version-resolution.md` §2).

- **Remote failures**:
  - If remote metadata fetch fails (network error, misconfig, auth issue, etc.):
    - Fall back to:
      - `available = local`.
    - Log/print a **warning** describing that only local data was used.

#### 2.2 Remote-primary mode (`mode = 'remote-primary'`, CLI `--remote`)

- **Version sources**:
  - Treat remote metadata as **authoritative**:
    - Use **remote versions only** for selection.
    - Ignore local-only versions that do not appear in remote metadata (`version-resolution.md` §7).

- **Behavior**:
  - If remote is unreachable:
    - Fail with a clear error indicating that `--remote` requires remote access.
  - If the chosen version already exists locally:
    - Install from local (no behavior change needed).
  - If the chosen version only exists remotely:
    - Pull then install (current remote-pull machinery).

#### 2.3 Local-only mode (`mode = 'local-only'`, CLI `--local`)

- **Version sources**:
  - Use **only local versions**:
    - `available = local`.
  - **Do not invoke** any remote metadata APIs or remote-pull flows in this mode:
    - No calls to `fetchRemotePackageMetadata`, `fetchMissingDependencyMetadata`, `pullMissingDependencies`, or `pullDownloadsBatchFromRemote`.

- **Behavior**:
  - If no local versions satisfy the constraint:
    - Fail with:
      - The requested range.
      - The list of available local versions (stable and WIP).
    - Suggest:
      - Dropping `--local` to allow remote resolution, or
      - Using `save` / `pack` to create a compatible local version.

---

### 3. Version Selection Algorithm

Implement the selection rules from `version-resolution.md` inside the dependency-resolution layer that serves `install` (likely `resolveDependencies` + helpers in `install-flow`).

#### 3.1 Constraint parsing

- Use a common parser (e.g. `parseVersionRange`) for:
  - Exact, caret, tilde, wildcard (`*`, `latest`), and comparison ranges.
- On parse failure:
  - **Fail early** with a user-facing error that:
    - Points to the invalid range string.
    - For canonical cases, instructs the user to fix the version in `.openpackage/package.yml`.
    - For fresh installs, asks the user to adjust the CLI spec.

#### 3.2 Core selection across modes

- Given `available: string[]` derived according to the current mode:
  - **Exact constraint**:
    - Select that exact version if present, otherwise error with “version not found” and nearest versions suggestion.
  - **Wildcard/latest**:
    - Prefer the **latest stable** version.
    - If no stable versions exist:
      - Use the **latest WIP/pre-release**, and clearly indicate in summary that a pre-release was chosen.
  - **Caret/tilde/comparison**:
    - Use `semver.maxSatisfying(available, range, { includePrerelease: true })` to get a candidate.
    - Apply WIP vs stable policy below.

#### 3.3 WIP vs stable policy

- Implement rules from `version-resolution.md` §5–6:
  - If both a stable `S` and WIPs `S-wip.*` satisfy the range:
    - **Select `S`**, even if WIPs have higher pre-release ordering.
  - If no stable satisfies the range but WIPs do:
    - Allow selecting the latest WIP **only when the constraint shows explicit pre-release intent**:
      - Exact WIP version string, or range that explicitly includes pre-releases.
  - For implicit “latest”/wildcard without pre-release intent:
    - Prefer guiding the user to **widen the range** rather than silently picking a WIP, if any stable line exists for that package.

---

### 4. `package.yml` as Canonical Source of Truth

Implement the canonical behavior described in `package-yml-canonical.md`.

#### 4.1 Reading canonical constraints

- At the start of `installCommand` (single-package cases):
  - Load `.openpackage/package.yml` if present.
  - Determine whether `<name>` exists in:
    - `packages[]`
    - `dev-packages[]`
  - Let `R_pkg` be the stored range string for `<name>` if present.

#### 4.2 Fresh dependencies (`<name>` not in `package.yml`)

- **Case A – `opkg install <name>`**:
  - Treat this as “install latest suitable version using default policy”:
    - Effective constraint: wildcard / `latest` internally.
    - Use the mode-aware version selection (default / remote-primary / local-only).
    - Let `S` be the selected version.
  - Mutate `package.yml`:
    - Add `<name>` to:
      - `packages` by default, or
      - `dev-packages` when `--dev` is set.
    - Stored version:
      - Default: **caret derived from `S`** (e.g. `^1.2.3`), with WIP-only edge cases handled per `package-yml-canonical.md`.

- **Case B – `opkg install <name>@<spec>`**:
  - Treat `<spec>` as the **initial canonical range**.
    - Parse `<spec>` and fail early if invalid.
  - Use `<spec>` as the constraint for version selection (respecting mode).
  - On success:
    - Install the selected version.
    - Persist `<spec>` **as-is** in `package.yml` (except for parser-required normalization).

#### 4.3 Existing dependencies (`<name>` already in `package.yml`)

- **Case C – `opkg install <name>`**:
  - Use `R_pkg` as the **only canonical constraint**.
  - Version selection:
    - Use mode-aware algorithm to choose latest-in-range from the appropriate version set.
  - Behavior:
    - If selected version == already-installed version:
      - Idempotent: no-op for that package (besides summaries).
    - If a newer satisfying version exists:
      - Upgrade to that version.
  - `package.yml`:
    - **Do not change** `R_pkg`.

- **Case D – `opkg install <name>@<spec>`**:
  - Treat `<spec>` as a **compatibility hint**:
    - Parse both `<spec>` and `R_pkg`.
    - Check compatibility (semver-equivalence or subset).
  - Outcomes:
    - If `<spec>` is compatible with `R_pkg`:
      - Proceed using **`R_pkg`** as the effective constraint.
      - Optionally log: “Using version range from package.yml (`R_pkg`); CLI spec `<spec>` is compatible.”
    - If `<spec>` is incompatible:
      - **Fail** with a clear error:
        - “Requested `<name>@<spec>`, but `.openpackage/package.yml` declares `<name>` with range `R_pkg`. Edit `package.yml` to change the dependency line, then re-run `opkg install`.”
      - Do **not** perform installs or change `package.yml`.

#### 4.4 Mutations allowed and disallowed

- **Allowed for `install`**:
  - Append new entries for fresh dependencies to `packages` / `dev-packages`.
- **Disallowed for `install`**:
  - Removing existing dependencies.
  - Rewriting existing version ranges, except for explicit, intentional future commands (e.g. an `upgrade` that is out-of-scope here).
  - Auto-fixing malformed ranges; instead:
    - Fail with an error instructing the user to edit `package.yml`.

---

### 5. Interaction with Existing Resolver (`resolveDependenciesForInstall`)

#### 5.1 Remove package.yml mutation on conflicts

- Current behavior:
  - On `VersionConflictError`, `resolveDependenciesForInstall`:
    - Prompts or force-selects a version.
    - Persists it into `package.yml` via `addPackageToYml`.
    - Re-resolves with updated constraints.

- New behavior:
  - For `install`:
    - **Do not mutate** `package.yml` in response to conflicts.
    - Instead:
      - Present a clear error or interactive choice of *which version to install now*, without updating canonical ranges.
      - Optionally suggest editing `package.yml` or using `save`/`pack`/`upgrade` for canonical changes.

#### 5.2 Mode-aware version sources

- Ensure `resolveDependenciesForInstall` (or lower-level helpers it relies on):
  - Use **resolution mode** to decide where versions come from (`available` sets as described in §2).
  - Avoid calling remote flows entirely in `local-only` mode.
  - Treat remote as authoritative in `remote-primary` mode.

---

### 7. WIP Content Resolution via `package.link.yml`

Implement the link-based WIP content behavior specified in `install-behavior.md` §7 and `version-resolution.md` §9.

#### 7.1 Loader behavior for local WIP versions

- Update or extend the package loading layer (e.g. `packageManager.loadPackage`) so that when:
  - A **WIP version** is selected for a package, and
  - The corresponding registry directory contains `package.link.yml`,
  it will:
  - Read `package.link.yml` to obtain `sourcePath`.
  - Treat `sourcePath` as the **root of the package contents**:
    - Enumerate files under `sourcePath` to build `pkg.files`.
    - Read `package.yml` under `sourcePath` for metadata.
  - Present the resulting `Package` object to the rest of the install pipeline exactly as if it came from a full copied registry version.

#### 7.2 Error handling for broken links

- If a selected WIP version has:
  - No `package.link.yml`, or
  - A malformed or unusable `sourcePath`:
  - The loader must:
    - Fail with a clear, user-facing error that:
      - Identifies the package and version (`<name>@<wipVersion>`).
      - Shows the expected path of `package.link.yml`.
      - Suggests:
        - Re-running `save` to regenerate the link, or
        - Using `pack` to create a stable version instead.
    - **Not silently fall back** to a different version.

#### 7.3 Remote considerations

- Link-based WIPs are **local-only artifacts**:
  - Stage 2 should **not** attempt to consume `package.link.yml` from remote registries.
  - If remote registries expose WIP versions, they should be:
    - Full copied artifacts that can be loaded like any other version, or
    - Explicitly excluded from selection according to the WIP vs stable policy.

---

### 8. UX & Error Messages

---

### 6. UX & Error Messages

- **When no version satisfies the constraint**:
  - Show:
    - Requested constraint.
    - Available stable versions.
    - Available WIP/pre-release versions.
  - Suggest:
    - Editing `package.yml` to broaden ranges (for canonical deps).
    - Using `save`/`pack` to create compatible versions.
    - Dropping `--local` if remote could help.

- **When CLI spec conflicts with `package.yml`**:
  - Use the canonical error text from `package-yml-canonical.md` §5.1.

- **When pre-release/WIP selected**:
  - Explicitly note in logs/summary that a **WIP/pre-release** version was chosen.

---

### 9. Testing Strategy for Stage 2

- **Mode-specific resolution tests**:
  - Default: union local+remote, including stable vs WIP selection.
  - `--remote`: ignore local-only versions.
  - `--local`: ignore remote-only versions and remote APIs.

- **Canonical behavior tests**:
  - Fresh dep adds correct entry to `package.yml` for:
    - `install foo`
    - `install foo@^1.2.3`
  - Existing dep:
    - `install foo` respects `R_pkg`.
    - `install foo@compatible` works and uses `R_pkg`.
    - `install foo@incompatible` fails with the canonical error.

- **Conflict and error UX tests**:
  - Invalid ranges in `package.yml` produce clear errors, not silent rewrites.
  - No unexpected `package.yml` mutations occur after install runs that only upgrade within range.
  - Broken WIP links (missing/invalid `package.link.yml`) produce clear errors and do not silently change selected versions.



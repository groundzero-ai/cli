### `opkg install` – Behavior & UX

This document defines the **user-facing behavior** of the `install` command, assuming:

- Versioning semantics from `save` / `pack` specs are already in place.
- `package.yml` is the **canonical declaration of direct dependencies** (see `package-yml-canonical.md`).
- Version selection obeys **“latest in range”**, with **local-first defaults for fresh installs without an explicit version** and **automatic fallback to remote when local cannot satisfy** (see `version-resolution.md`).

---

## 1. Command shapes

- **`opkg install`**
  - **Meaning**: Materialize *all* dependencies declared in `.openpackage/package.yml` into the workspace, at the **latest versions that satisfy their declared ranges**, using both local and remote registries.

- **`opkg install <name>`**
  - **Meaning**:
    - If `<name>` is **already declared** in `package.yml`: ensure it is installed at the **latest version that satisfies the `package.yml` range**.
    - If `<name>` is **not declared**: perform a **fresh install**, resolve the target version using local+remote, then add a new entry to `package.yml` (see §3).

- **`opkg install <name>@<spec>`**
  - **Meaning**:
    - If `<name>` is **already declared** in `package.yml`: `<spec>` is treated as a **constraint hint** that must be **compatible** with the canonical `package.yml` range (see `package-yml-canonical.md` for rules).
    - If `<name>` is **not declared**: `<spec>` is treated as the **initial version range** to store in `package.yml`, and resolution uses local+remote under that range.

Other flags (`--dev`, `--remote`, `--platforms`, `--dry-run`, `--stable`, conflicts) keep their existing semantics unless overridden below.

---

## 2. High-level goals

- **G1 – Single mental model**:
  - **“`package.yml` declares intent, `install` materializes the newest versions that satisfy that intent.”**

- **G2 – Latest in range with local-first defaults**:
  - Whenever a version needs to be chosen for install, the system:
    - For **fresh dependencies** (e.g. `opkg install <name>` or `opkg install <name>@<spec>` where `<name>` is not yet in `package.yml`), first tries to satisfy the effective range from the **local registry only**, then falls back to include **remote versions** when local cannot satisfy.
    - For **existing dependencies** (already declared in `package.yml`, with or without CLI hints), combine **local and remote registry versions** as described in `version-resolution.md`, then choose the highest satisfying semver version (including pre-releases where allowed by policy).

- **G3 – Minimal UX surface**:
  - `install` doubles as both:
    - “Install what’s declared” (no args).
    - “Upgrade within range” (re-run with no args or with a name).
  - A separate `upgrade` command remains optional and can later be added for **range-bumping workflows** (e.g. changing `^1.2.3` → `^2.0.0`).

---

## 3. Fresh vs existing dependencies

### 3.1 Fresh dependency (`<name>` not in package.yml)

- **Inputs**:
  - CLI: `opkg install <name>` or `opkg install <name>@<spec>`.
  - `--dev` determines whether the dep is added to `packages` or `dev-packages`.

- **Behavior**:
  - **Case A – `opkg install <name>` (no version spec)**:
    - Compute **available versions** from the **local registry only** for the first resolution attempt (no remote metadata is consulted initially).
    - **Default behavior**: Select the **latest semver version** from this local set that satisfies the internal wildcard range (`*`), **including pre-releases/WIPs**. If the selected version is a pre-release/WIP, the CLI should state that explicitly.
    - **With `--stable` flag**: From the local set, select the **latest stable** version `S` if any exist. If only WIP or pre-releases exist locally, select the latest WIP/pre-release.
    - If **no local versions exist** or **no local version satisfies the implicit range**:
      - In **default mode** (no `--local`), `install` MUST:
        - Attempt resolution again including **remote versions**, following the rules in `version-resolution.md` (local+remote union and WIP/stable policies).
        - Only fail if **neither local nor remote** provide a satisfying version, or remote metadata is unavailable.
      - In **`--local` mode**, this remote fallback is **disabled** and the command fails with a clear “not available locally” style error that may suggest re-running without `--local` or using `save` / `pack`.
    - **Install `<name>@<selectedVersion>`**.
    - **Add to `package.yml`**:
      - Default range is **caret based on the stable base** of the selected version (e.g. `^1.0.1` for `1.0.1-000fz8.a3k`), unless later overridden by a global policy.

  - **Case B – `opkg install <name>@<spec>`**:
    - Treat `<spec>` as the **initial canonical range**:
      - Parse `<spec>` using the same semantics as `version-ranges` (exact, caret, tilde, wildcard, comparison).
    - Resolve using the **local-first with remote fallback** policy for fresh dependencies (per `version-resolution.md`):
      - First, attempt to satisfy `<spec>` using only **local registry versions**.
      - If no satisfying local version exists:
        - In **default mode** (no `--local`), include **remote versions** and retry selection over the combined set, allowing a remote version to be selected when it is the only match.
        - In **`--local` mode**, do **not** fall back to remote; fail with a clear error indicating no local version satisfies `<spec>`.
    - **Install the selected version**.
    - **Persist `<spec>` in `package.yml`** (do not auto-normalize beyond what the version-range parser requires).

### 3.2 Existing dependency (`<name>` already in package.yml)

- **Inputs**:
  - Canonical range from `package.yml` (see `package-yml-canonical.md`).
  - Optional CLI `<spec>` from `install <name>@<spec>`.

- **Behavior**:
  - `opkg install <name>`:
    - Use the **canonical range from `package.yml`**.
    - Compute available versions from **local+remote** (per `version-resolution.md`), allowing remote versions to be selected when no satisfying local version exists (in default mode).
    - **Install / upgrade to the latest satisfying version** (if newer than current).
  - `opkg install <name>@<spec>`:
    - Treat `<spec>` as a **sanity check** against the canonical range:
      - If compatible (according to rules in `package-yml-canonical.md`), proceed as above.
      - If incompatible, **fail with a clear error** instructing the user to edit `package.yml` instead of using CLI-only overrides.

---

### 3.3 Selection summary UX (local vs remote)

- After resolving the root version for any `install` invocation (fresh or existing dependency), the CLI MUST print a one-line summary indicating **where the chosen version came from**:
  - If the selected version is backed by the **local registry**:
    - Print: `✓ Selected local @<name>@<version>`.
  - If the selected version is obtained from **remote metadata/registry**:
    - Print: `✓ Selected remote @<name>@<version>`.
- For **scoped packages** (e.g. `@hyericlee/nextjs`), this formatting naturally yields output like:
  - `✓ Selected local @@hyericlee/nextjs@0.3.1`
  - `✓ Selected remote @@hyericlee/nextjs@0.3.1`
- This summary line complements any additional logging and should appear **once per top-level install invocation**, clearly tying the resolution decision to its source (local vs remote).

---

## 4. `opkg install` (no args) – “refresh workspace to intent”

- **Inputs**:
  - `.openpackage/package.yml`:
    - `packages[]` and `dev-packages[]`, each with `name` and `version` (range or exact).

- **Behavior**:
  - For each declared dependency:
    - Determine its **effective range** (canonical, possibly reconciled with any global overrides).
    - Resolve **latest satisfying version from local+remote**.
    - If that version is **already installed**, **do nothing** (idempotent).
    - If a **newer satisfying version exists**, **upgrade** the installed version to that one.
  - This makes `opkg install` act as:
    - **“Hydrate my workspace to match `package.yml`”** on first run.
    - **“Upgrade within my declared ranges”** on subsequent runs.

---

## 5. Remote interaction modes

### 5.1 Default mode (no `--remote`)

- When resolving versions (for both the root target and **all recursive dependencies**):
  - Resolution obeys the **local-first with remote fallback** policy from `version-resolution.md`:
    - First, attempt to satisfy the effective constraint using **only local registry versions**.
    - If no satisfying local version exists and remote is **reachable**:
      - Fetch remote metadata, compute the **union of local+remote versions**, and retry selection over this combined set.
      - If the chosen version does not yet exist locally, it will be **pulled from remote** (subject to existing remote-flow prompts and dry-run behavior).
    - If remote is **unreachable or misconfigured**:
      - The resolver remains effectively **local-only** and fails when no satisfying local version exists, emitting a clear warning or error that remote lookup failed.

### 5.2 `--remote` flag

- `opkg install --remote` or `opkg install <name> --remote`:
  - **Forces remote-primary behavior**:
    - Resolution *may* still consider local versions, but:
      - Remote metadata is treated as authoritative for **available versions**.
      - Selected versions are **guaranteed to exist remotely**; local-only versions are ignored for selection.
  - Intended for:
    - Ensuring compatibility with what is actually **published** remotely.
    - CI / reproducibility scenarios where local cache should not affect choices.

---

## 6. WIP vs stable on install

High-level rules (details in `version-resolution.md`):

- **Default behavior: Latest-in-range, including WIP**:
  - For any non-exact constraint (wildcard or range), the resolver chooses the **highest semver version** that satisfies the range, regardless of whether it is stable or WIP/pre-release.
  - This ensures that `opkg install <name>` naturally selects the newest available version, including WIPs, which is useful for development workflows.
  - When a WIP/pre-release is selected, `opkg install` output should clearly indicate that the installed version is a pre-release/WIP.

- **With `--stable` flag: Stable-preferred policy**:
  - For a given base stable `S`, if both:
    - Stable `S`, and
    - WIPs `S-<t>.<w>`
    exist and satisfy the range, **prefer `S`**.
  - WIP/pre-release versions are only selected when **no stable versions** exist that satisfy the range.
  - This is useful for CI/production scenarios where stability is preferred over the absolute latest version.

---

## 7. WIP content resolution (unified with stable)

This section ties WIP version selection to **how content is loaded** when the selected version is a WIP prerelease, assuming both WIP and stable versions are stored as full copies in the local registry.

- **Registry layout for WIP versions**:
  - For WIP saves, the local registry contains a **full copy** of the package:
    - Path: `~/.openpackage/registry/<pkg>/<wipVersion>/...`.
    - Contents mirror the workspace package at the time of `save`, just like stable copies.

- **Install behavior when a WIP version is selected**:
  - When the version resolution layer selects a **WIP version** that exists locally:
    - The package loader (e.g. `packageManager.loadPackage`) MUST:
      - Load files directly from the WIP registry directory (`~/.openpackage/registry/<pkg>/<wipVersion>/...`).
      - Read the `package.yml` from that directory for metadata.
      - Treat this data exactly as it would for a stable registry copy for the purposes of installation and dependency resolution.
  - If the WIP registry directory is missing or malformed for a selected WIP version:
    - Install MUST **fail clearly**, indicating the broken WIP copy and suggesting:
      - Re-running `save`/`pack` to regenerate the version, or
      - Using a different available version instead.

- **Remote considerations**:
  - Both WIP and stable versions exposed by remote registries are treated as **normal copied packages**.
  - There is no link-based indirection layer in the registry layout for WIP versions.

---

## 8. Compatibility and non-goals

- **Non-goal**: Emulate every nuance of npm’s `install` / `update` / `dedupe` behavior.
  - Instead, aim for a **small, orthogonal core**:
    - `package.yml` declares intent.
    - `save`/`pack` manage versions & WIPs.
    - `install` materializes **latest-in-range** from local+remote.

- **Compatibility goal**:
  - A user coming from npm should be able to reason as:
    - “`package.yml` is like `package.json` dependencies.”
    - “`opkg install` is like `npm install`: it installs & upgrades within ranges.”
    - “To change which major I target, I edit the version in `package.yml`, not the CLI.”



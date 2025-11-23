### `opkg install` – Behavior & UX

This document defines the **user-facing behavior** of the `install` command, assuming:

- Versioning semantics from `save` / `pack` specs are already in place.
- `package.yml` is the **canonical declaration of direct dependencies** (see `package-yml-canonical.md`).
- Version selection obeys **“latest in range from local+remote”** (see `version-resolution.md`).

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

Other flags (`--dev`, `--remote`, `--platforms`, `--dry-run`, conflicts) keep their existing semantics unless overridden below.

---

## 2. High-level goals

- **G1 – Single mental model**:
  - **“`package.yml` declares intent, `install` materializes the newest versions that satisfy that intent.”**

- **G2 – Latest in range from local+remote**:
  - Whenever a version needs to be chosen for install, the system:
    - Collects **local registry versions**.
    - Collects **remote registry versions** (if reachable).
    - Chooses the **highest semver version** that satisfies the effective range (including pre-releases where allowed by policy).

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
    - Compute **available versions** from local+remote.
    - Select **latest stable** version `S` if any exist.
      - If only WIP or pre-releases exist, follow policy from `version-resolution.md`.
    - **Install `<name>@S`**.
    - **Add to `package.yml`**:
      - Default range is **caret based on `S`** (e.g. `^1.2.3`), unless later overridden by a global policy.

  - **Case B – `opkg install <name>@<spec>`**:
    - Treat `<spec>` as the **initial canonical range**:
      - Parse `<spec>` using the same semantics as `version-ranges` (exact, caret, tilde, wildcard, comparison).
    - Use **local+remote available versions** and choose the **best version satisfying `<spec>`**.
    - **Install that version**.
    - **Persist `<spec>` in `package.yml`** (do not auto-normalize beyond what the version-range parser requires).

### 3.2 Existing dependency (`<name>` already in package.yml)

- **Inputs**:
  - Canonical range from `package.yml` (see `package-yml-canonical.md`).
  - Optional CLI `<spec>` from `install <name>@<spec>`.

- **Behavior**:
  - `opkg install <name>`:
    - Use the **canonical range from `package.yml`**.
    - Compute available versions from local+remote.
    - **Install / upgrade to the latest satisfying version** (if newer than current).
  - `opkg install <name>@<spec>`:
    - Treat `<spec>` as a **sanity check** against the canonical range:
      - If compatible (according to rules in `package-yml-canonical.md`), proceed as above.
      - If incompatible, **fail with a clear error** instructing the user to edit `package.yml` instead of using CLI-only overrides.

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

- When resolving versions:
  - The resolver **attempts to consult remote metadata** to augment the local version set.
  - If remote is **reachable**:
    - The **union of local+remote versions** is used for selecting the latest satisfying version.
    - If a chosen version is not yet present locally, it will be **pulled from remote** (subject to existing remote-flow prompts and dry-run behavior).
  - If remote is **unreachable or misconfigured**:
    - The resolver **falls back to local-only** versions.
    - A warning is logged (but the install can still succeed using local data).

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

- **Stable over WIP**:
  - For a given base stable `S`, if both:
    - Stable `S`, and
    - WIPs `S-wip.*`
    exist and satisfy the range, **prefer `S`**.

- **WIP only when stable absent or explicitly requested**:
  - If **no stable versions** exist that satisfy the range, WIP or other pre-releases may be selected when:
    - The range **explicitly allows pre-release** semantics (e.g. exact WIP string), or
    - A **policy in `version-resolution.md`** allows falling back to WIPs in constrained situations.

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



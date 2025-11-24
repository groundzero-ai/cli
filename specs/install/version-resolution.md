### Install Version Resolution – Local + Remote

This document specifies how `install` chooses **which concrete version** of a package to install, given:

- A **package name**.
- An **effective version constraint** (from `package.yml` and/or CLI).
- Access to **local registry versions** and optionally **remote registry metadata**.

The goal is to implement **“latest in range from local+remote”** deterministically, with clear WIP vs stable semantics.

---

## 1. Inputs and terminology

- **Name**: package name, e.g. `formula-main`.
- **Constraint**:
  - A string understood by `version-ranges` (exact, caret, tilde, wildcard, comparison).
  - Examples: `1.2.3`, `^1.2.0`, `~2.0.1`, `>=3.0.0 <4.0.0`, `*`, `latest`.
- **Local versions**:
  - Semver versions discoverable via `listPackageVersions(name)` from the **local registry**.
  - Includes both **stable** and **WIP/pre-release** versions, e.g. `1.2.3`, `1.2.3-000fz8.a3k`.
- **Remote versions**:
  - Semver versions discoverable via remote metadata APIs (e.g. via `fetchRemotePackageMetadata` / registry metadata).
  - Also includes both **stable** and **WIP/pre-release** versions.

---

## 2. Effective available versions

- **Base rule**:
  - The **effective `available` set** depends on the resolution mode and scenario:
    - **Local-only / explicit `--local`**:
      - **`available = local`**.
      - Remote metadata is **never** consulted; if no satisfying local version exists, resolution fails (see error behavior).
    - **Fresh dependency installs in default mode** (e.g. `opkg install <name>` or `opkg install <name>@<spec>` where `<name>` is **not yet declared** in `package.yml`):
      - Version selection is **local-first with remote fallback**, regardless of whether the effective constraint is a wildcard or an explicit range:
        - Step 1 – **Local-only attempt**:
          - Start with **`available_local = local`**.
          - Attempt selection using only `available_local` (see §4–§6).
        - Step 2 – **Fallback to remote when local cannot satisfy**:
          - If **no local versions exist at all**, or
          - No local versions satisfy the effective constraint:
            - When remote metadata is available:
              - Fetch remote versions and compute **`available = dedup(local ∪ remote)`**.
              - Re-run selection against this expanded `available` set.
            - When remote metadata is not available (network error, misconfiguration, unauthenticated, etc.):
              - Resolution fails with a clear error that:
                - Explains that no satisfying local version exists, and
                - Mentions that remote lookup also failed (or was disabled).
    - **Existing dependencies in default mode** (e.g. entries already in `package.yml`, or dependencies declared in nested `package.yml` files during recursive resolution):
      - Resolution also follows a **local-first with remote fallback** policy:
        - Step 1 – **Local-only attempt**:
          - Use **only local registry versions** that match the declared range to build `available_local`.
        - Step 2 – **Fallback to remote when local cannot satisfy**:
          - If **no local versions exist at all**, or
          - No local versions satisfy the effective constraint:
            - When remote metadata is available:
              - Fetch remote versions and compute **`available = dedup(local ∪ remote)`**.
              - Re-run selection against this expanded `available` set.
            - When remote metadata is not available:
              - Resolution fails with a clear error explaining that no satisfying local version exists and remote lookup failed or was disabled.

- **Deduping**:
  - Versions are deduped by their **full semver string** (`1.2.3-000fz8.a3k` vs `1.2.3` are distinct).

- **Ordering**:
  - For selection, versions are sorted in **descending semver order**:
    - Use `semver.compare(b, a)` semantics.
    - **Pre-releases and WIPs** are ordered according to standard semver rules.

---

## 3. Constraint parsing

- **Parsing**:
  - All constraints are parsed via `parseVersionRange` or equivalent.
  - Supported types:
    - **exact** (`1.2.3`)
    - **caret** (`^1.2.3`)
    - **tilde** (`~1.2.3`)
    - **wildcard** (`*`, `latest`)
    - **comparison** (`>=1.0.0 <2.0.0`, `>=2.0.0-0`, etc.)

- **Invalid constraints**:
  - If the constraint string cannot be parsed:
    - The install operation **fails early** with a clear error.
    - The user is instructed to fix the version in `package.yml` for canonical cases, or in the CLI for fresh installs.

---

## 4. Selection algorithm (high level)

Given `available: string[]` and a parsed constraint:

- **If constraint is `exact`**:
  - **Pick that exact version** if it exists in `available`.
  - Otherwise:
    - Fail with **"version not found"** and list the nearest available versions (see error UX section).

- **If constraint is `wildcard` / `latest`** (default behavior):
  - Use `semver.maxSatisfying(available, '*', { includePrerelease: true })` to find the **highest semver version**.
  - **Select the single highest version**, regardless of whether it is stable or WIP/pre-release.
  - If the selected version is a pre-release/WIP, the CLI should make that explicit in its output.

- **If constraint is `caret`, `tilde`, or `comparison`** (default behavior):
  - Use `semver.maxSatisfying(available, range, { includePrerelease: true })` to find the **highest satisfying version**.
  - **Select that version** (stable or pre-release/WIP).
  - No additional "downgrade WIP to stable" heuristic is applied; WIP/pre-release versions are first-class semver versions for resolution purposes.

- **With `--stable` flag**:
  - The selection follows the **stable-preferred policy** described in §5.2.
  - For wildcard/ranges: if any satisfying stable version exists, pick the **latest satisfying stable**.
  - Only pick prerelease/WIP when **no satisfying stable exists at all**.

If no version satisfies the constraint:

- The operation **fails** with:
  - A clear description of:
    - The requested range.
    - The set of available stable and WIP versions.
  - Suggestions for:
    - Editing `package.yml` to broaden the range.
    - Using `pack` / `save` to create a compatible version.

---

## 5. WIP vs stable selection policy

### 5.1 Definitions

- Let **`S`** be a stable version string, e.g. `1.2.3`.
- Let **`W(S)`** be the set of WIP versions derived from `S`, e.g.:
  - `1.2.3-<t>.<w>`.

### 5.2 Default policy: Latest wins (stable and WIP treated uniformly)

- **Latest-in-range selection**:
  - Among all versions that satisfy the constraint, **choose the highest semver version** according to normal semver ordering (with pre-releases ordered per semver).
  - WIP versions (`S-<t>.<w>`) are just a subset of pre-release versions; there is no special demotion to their base stable.
  - This ensures that `opkg install <name>` naturally selects the newest available version, including WIPs, which is useful for development workflows.

- **Pre-release transparency**:
  - When the chosen version is a pre-release/WIP, the CLI **surfaces that fact** in messages and summaries, but does not alter the chosen version.
  - This helps users understand when they're working with pre-release code.

### 5.3 Stable-preferred policy (used with `--stable` flag)

- **Stable dominates WIP for the same base line**:
  - If both:
    - A stable `S`, and
    - One or more WIPs in `W(S)`
    **satisfy the constraint**, then:
    - **Select `S`**, even if some WIPs have a higher pre-release ordering.
  - Rationale:
    - Matches the mental model that **packed stable** is the canonical release.
    - Useful for CI/production scenarios where stability is preferred.

- **WIP only when stable is not an option**:
  - If:
    - No stable versions exist in `available` that satisfy the constraint, but
    - One or more WIP (or other pre-release) versions do:
    - The resolver picks the **latest WIP** that satisfies the constraint.
  - For implicit "latest" / wildcard constraints:
    - If **any stable versions** exist at all for that package (even if outside the requested range), prefer telling the user to **widen the range** rather than silently pulling a WIP.

---

## 6. Behavior per constraint type

### 6.1 Exact versions (incl. exact WIP)

- **Example**: `install foo@1.2.3-000fz8.a3k`.
- Behavior:
  - Use **exact match**:
    - If that exact version is in `available`, select it.
    - Otherwise, fail with **“exact version not found”**, show nearby versions.
  - No additional WIP/stable heuristics are applied.

### 6.2 Wildcard / latest (`*`, `latest`)

- **Fresh dependency default (wildcard)**:
  - For `opkg install <name>` where `<name>` is not yet in `package.yml` and the effective constraint is wildcard/latest:
    - Resolution follows the **local-first with remote fallback** policy (see §2 and §7):
      - First, attempt selection using **only local versions** as `available`.
      - If no local versions exist, or none satisfy the wildcard constraint:
        - When remote metadata is available, expand `available` to **`dedup(local ∪ remote)`** and retry selection.
        - Only if **no satisfying version exists in either local or remote**, or remote lookup fails, does the operation error.

- **Default behavior (given an `available` set)**:
  - Use `semver.maxSatisfying(available, '*', { includePrerelease: true })` to find the **highest semver version**.
  - Select that version (stable or WIP/pre-release).
  - If the selected version is a pre-release/WIP, the CLI output should make that explicit.

- **With `--stable` flag**:
  - If **stable versions exist** in `available`, select the **latest stable**.
  - If **no stable versions exist**:
    - Select the **latest WIP / pre-release**.
    - The summary should make it explicit that a **pre-release** was chosen.

### 6.3 Caret / tilde (`^`, `~`)

- **Default behavior**:
  - Use `maxSatisfying` with `{ includePrerelease: true }` to find the **highest satisfying version**.
  - Select that version directly (stable or WIP/pre-release), using the `available` pool determined by the mode and scenario in §2–§3 (including local-first-with-fallback for fresh dependencies).

- **With `--stable` flag**:
  - Use `maxSatisfying` with `{ includePrerelease: true }` to find the **highest satisfying version**.
  - Then:
    - If that best version is **stable**, use it.
    - If it is **WIP**:
      - Check whether the **base stable line** of that WIP (`S`) also has a stable version in `available` satisfying the range.
      - If yes, **pick `S` instead**.
      - If no, accept the WIP version.

### 6.4 Comparison ranges

- **Default behavior**:
  - Use `semver.maxSatisfying(available, range, { includePrerelease: true })` to find the **highest satisfying version**.
  - Select that version directly (stable or WIP/pre-release), using the `available` pool determined by the mode and scenario in §2–§3 (including local-first-with-fallback for fresh dependencies).

- **With `--stable` flag**:
  - Same as caret/tilde with `--stable`, but using the exact comparison string.
  - The stable-preferred rules from §5.3 apply.

---

## 7. Local vs remote precedence

- **Default mode**:
  - For **all dependency resolutions in default mode** (root package and recursive dependencies, whether or not they are already declared in some `package.yml`):
    - The resolver behaves as **local-first with automatic fallback to remote** as described in §2:
      - It first attempts to satisfy the effective constraint using **local versions only**.
      - If no satisfying local version exists, it **includes remote versions** (when available) and retries selection over the combined set.
      - Only when **neither local nor remote** can satisfy the constraint does it fail with a “no matching versions found” style error.
  - For **fresh dependencies** (`opkg install <name>` or `opkg install <name>@<spec>` where `<name>` is not yet in `package.yml`, and `--local` is **not** set):
    - This is just a special case of the general rule above, where the dependency is being introduced for the first time into the workspace.

- **`--remote` mode**:
  - Remote metadata is treated as **authoritative** for which versions exist.
  - Local-only versions **not present in remote metadata** are ignored for selection.
  - This guarantees that installed versions are **publishable/known remotely**.

---

## 8. Examples (informal)

These examples assume remote is reachable.

- **Example 1 – Simple caret range**:
  - `package.yml`: `foo: ^1.2.0`
  - Local: `1.2.3`, `1.3.0`
  - Remote: `1.3.1`
  - Selected: **`1.3.1`**.

- **Example 2 – WIP and stable (default behavior)**:
  - `package.yml`: `foo: ^1.2.0`
  - Local: `1.2.3-000fz8.a3k`, `1.2.3`, `1.3.0-000fz9.a3k`
  - Remote: `1.3.0`
  - Satisfying: `1.2.3`, `1.3.0-000fz9.a3k`, `1.3.0`
  - Selected: **`1.3.0`** (highest semver version).
  - With `--stable`: **`1.3.0`** (same result, stable preferred).

- **Example 2b – WIP and stable (WIP is newer)**:
  - `package.yml`: `foo: ^1.2.0`
  - Local: `1.2.3`, `1.3.0-000fz9.a3k`
  - Remote: `1.3.0`
  - Satisfying: `1.2.3`, `1.3.0-000fz9.a3k`, `1.3.0`
  - Selected (default): **`1.3.0-000fz9.a3k`** (highest semver, even though WIP).
  - With `--stable`: **`1.3.0`** (stable preferred over WIP).

- **Example 3 – No stable exists**:
  - `package.yml`: `foo: ^1.0.0-0` (or explicit WIP version).
  - Local: none.
  - Remote: `1.0.0-000fz8.a3k`, `1.0.1-000fz9.a3k`
  - Selected: **`1.0.1-000fz9.a3k`**.

- **Example 4 – Wildcard with only WIPs**:
  - CLI: `install foo` (fresh dep, default wildcard internally).
  - Local: none.
  - Remote: `0.1.0-000fz8.a3k`
  - Selected: **`0.1.0-000fz8.a3k`**, but:
    - The CLI should make it clear the installed version is a **pre-release/WIP**.
    - The stored range in `package.yml` may be **exact** or chosen policy-driven (e.g. exact WIP string).

---

## 9. Content resolution for WIP versions

Version resolution chooses **which version string** to install; this section summarizes how content for **local WIP versions** is sourced, and defers full behavior to `install-behavior.md`.

- **Local WIP versions as full copies**:
  - When the selected version is a WIP that exists locally, it is represented as a **full copied package** in the registry:
    - Path: `~/.openpackage/registry/<pkg>/<wipVersion>/...`.
    - The loader must:
      - Load package files directly from that directory.
      - Read the `package.yml` from that directory for metadata.
  - The resolved version string (`S-<t>.<w>`) still participates in semver ordering and dependency resolution as specified above.

- **Remote WIPs**:
  - Remote registries are expected to expose **copied artifacts** for any WIP versions they publish.
  - WIP versions from remote are treated the same as stable versions for content loading (normal registry copies).

- **Error behavior**:
  - If a WIP version is selected but its registry directory is missing or malformed:
    - The install operation should fail with a clear error instead of silently falling back to another version.
    - The error should point to:
      - The problematic WIP version string.
      - The expected registry path.
      - Suggested remediation (re-save, pack to stable, or choose a different version).



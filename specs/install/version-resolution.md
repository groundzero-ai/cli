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
  - Includes both **stable** and **WIP/pre-release** versions, e.g. `1.2.3`, `1.2.3-wip.abc12345`.
- **Remote versions**:
  - Semver versions discoverable via remote metadata APIs (e.g. via `fetchRemotePackageMetadata` / registry metadata).
  - Also includes both **stable** and **WIP/pre-release** versions.

---

## 2. Effective available versions

- **Base rule**:
  - When remote is available:
    - **`available = dedup(local ∪ remote)`**.
  - When remote is not available (network error, misconfiguration, unauthenticated, etc.):
    - **`available = local`**, and a warning is emitted.

- **Deduping**:
  - Versions are deduped by their **full semver string** (`1.2.3-wip.abc` vs `1.2.3` are distinct).

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
    - Fail with **“version not found”** and list the nearest available versions (see error UX section).

- **If constraint is `wildcard` / `latest`**:
  - **Prefer stable versions**:
    - If any stable versions exist in `available`, pick the **latest stable**.
    - If no stable versions exist, pick the **latest available version** (which may be WIP or other pre-release).

- **If constraint is `caret`, `tilde`, or `comparison`**:
  - Use `semver.maxSatisfying(available, range, { includePrerelease: true })` to compute a **candidate**.
  - Apply the **WIP vs stable policy** in §5 to decide whether to accept that candidate or prefer a different one.

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
  - `1.2.3-wip.<timestamp>.<workspaceHash>`.

### 5.2 General rules

- **Stable dominates WIP for the same base line**:
  - If both:
    - A stable `S`, and
    - One or more WIPs in `W(S)`
    **satisfy the constraint**, then:
    - **Select `S`**, even if some WIPs have a higher pre-release ordering.
  - Rationale:
    - Matches the mental model that **packed stable** is the canonical release.
    - Keeps WIPs an explicit opt-in for installs.

- **WIP only when stable is not an option**:
  - If:
    - No stable versions exist in `available` that satisfy the constraint, but
    - One or more WIP (or other pre-release) versions do:
    - The resolver may pick the **latest WIP** that satisfies the constraint, *if and only if*:
      - The constraint is **explicit enough** to suggest intentional WIP use:
        - e.g. an exact WIP version string, or a range that explicitly includes that pre-release.
  - For implicit “latest” / wildcard constraints without explicit pre-release intent:
    - If **any stable versions** exist at all for that package (even if outside the requested range), the error should:
      - Prefer telling the user to **widen the range** rather than silently pulling a WIP.

---

## 6. Behavior per constraint type

### 6.1 Exact versions (incl. exact WIP)

- **Example**: `install foo@1.2.3-wip.20241123a.abc12345`.
- Behavior:
  - Use **exact match**:
    - If that exact version is in `available`, select it.
    - Otherwise, fail with **“exact version not found”**, show nearby versions.
  - No additional WIP/stable heuristics are applied.

### 6.2 Wildcard / latest (`*`, `latest`)

- Behavior:
  - If **stable versions exist** in `available`, select the **latest stable**.
  - If **no stable versions exist**:
    - Select the **latest WIP / pre-release**.
    - The summary should make it explicit that a **pre-release** was chosen.

### 6.3 Caret / tilde (`^`, `~`)

- Behavior:
  - Use `maxSatisfying` with `{ includePrerelease: true }` to find the **highest satisfying version**.
  - Then:
    - If that best version is **stable**, use it.
    - If it is **WIP**:
      - Check whether the **base stable line** of that WIP (`S`) also has a stable version in `available` satisfying the range.
      - If yes, **pick `S` instead**.
      - If no, accept the WIP version.

### 6.4 Comparison ranges

- Behavior:
  - Same as caret/tilde, but using the exact comparison string.
  - The WIP vs stable rules from §5 still apply.

---

## 7. Local vs remote precedence

- **Default mode**:
  - `available` is the **union** of local and remote.
  - Version choice is **purely semver-based**; there is no bias toward local if a newer remote version exists.
  - If the chosen version:
    - Already exists locally, it is installed from local.
    - Only exists remotely, it is **pulled then installed**.

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

- **Example 2 – WIP and stable**:
  - `package.yml`: `foo: ^1.2.0`
  - Local: `1.2.3-wip.aaa`, `1.2.3`, `1.3.0-wip.bbb`
  - Remote: `1.3.0`
  - Satisfying: `1.2.3`, `1.3.0-wip.bbb`, `1.3.0`
  - Selected: **`1.3.0`** (stable dominates WIP).

- **Example 3 – No stable exists**:
  - `package.yml`: `foo: ^1.0.0-0` (or explicit WIP version).
  - Local: none.
  - Remote: `1.0.0-wip.aaa`, `1.0.1-wip.bbb`
  - Selected: **`1.0.1-wip.bbb`**.

- **Example 4 – Wildcard with only WIPs**:
  - CLI: `install foo` (fresh dep, default wildcard internally).
  - Local: none.
  - Remote: `0.1.0-wip.aaa`
  - Selected: **`0.1.0-wip.aaa`**, but:
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
  - The resolved version string (`S-wip.*`) still participates in semver ordering and dependency resolution as specified above.

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



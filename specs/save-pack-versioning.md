### Save / Pack Versioning Specification

This document captures the agreed behavior for versioning when splitting `save` and `pack`, and how `package.yml`, `package.index.yml`, and registry metadata interact.

---

### 1. Version Sources and Responsibilities

- **`<pkg>/package.yml`**
  - **Owner**: User, with limited, predictable CLI auto‑bump.
  - **Role**: Declares the **next intended stable version** for the package.
  - **Version field semantics**:
    - Before `pack`, represents the **stable version `S` that will be published** (e.g. `1.2.3`, `3.0.0`).
    - After a successful `pack` of `S`, the CLI automatically bumps this to `patch(S)` (e.g. `1.2.3 → 1.2.4`) to prepare for the next cycle.
    - Is the **canonical source of truth** any time the CLI must choose a version.
  - **Mutations**:
    - **User** can edit this manually at any time (e.g. jump from `1.2.4` to `2.0.0` for a major).
    - **CLI**:
      - `save` **never** mutates `package.yml.version`.
      - `pack` updates `package.yml.version` from `S` to `patch(S)` **only after a successful pack of `S`**.

- **`<pkg>/package.index.yml`**
  - **Owner**: CLI (tool-managed).
  - **Role**:
    - Tracks the **last effective version saved from this workspace** (WIP or stable).
    - Tracks `files` mapping from registry-like keys to installed workspace paths (same as current behavior).
  - **Fields**:
    - `workspace.version`:
      - After `save`: the **exact WIP version** (e.g. `1.2.3-wip.<ts>.<ws>`).
      - After `pack`: the **exact stable version** that was packed (e.g. `1.2.3`).
    - `workspace.hash`:
      - 8-character hash derived from the current workspace path (`cwd`).
      - Used to scope cleanup of WIP link entries to this workspace.
    - `files`: last saved file mapping snapshot.
  - **Priority vs `package.yml`**:
    - **Advisory only** for continuity (e.g. showing last WIP or stable).
    - When `package.yml.version` and `package.index.yml.workspace.version` disagree, **`package.yml.version` wins**.

- **Registry layout (unified for WIP and stable)**
  - Stable copies:
    - Stored under: `~/.openpackage/registry/<pkg>/<version>/...` with full contents.
  - WIP copies:
    - For WIP saves, the registry also contains a **full copy** of the package:
      - Path: `~/.openpackage/registry/<pkg>/<wipVersion>/...`.
      - Contents mirror the workspace package at the time of `save`, just like stable copies.
    - There is **no special `package.link.yml` indirection**; WIP versions are materialized the same way as stable versions, differentiated only by their version strings.

---

### 2. WIP Version Scheme

- **Goal**:
  - Keep `package.yml.version` as a clean, user-visible **next stable target**.
  - Ensure WIP versions:
    - Are clearly attributable to a workspace and save moment.
    - Are semver pre‑releases of the exact version the user intends to ship next.

- **Given**:
  - `package.yml.version = S` (next intended stable string, e.g. `1.2.3`).

- **Definitions**:
  - A **WIP version** is of the form:
    - `S-wip.<timestamp>.<workspaceHash>`
    - Example: `1.2.3-wip.20241123a.abc12345`.

- **Semver ordering**:
  - For the above:
    - `S-wip.* < S`.
  - This preserves:
    - A clean, user-chosen stable `S` in `package.yml`.
    - WIP versions as **pre-releases of that exact upcoming stable**.

---

### 3. `save` Command Versioning Behavior

> **CLI contract**:
> - `save` has **no `--bump` option**.
> - `save` does **not** support `<pkg>@<version>` syntax; it always derives its versioning behavior from `package.yml.version` for the target package.
> - It always computes the WIP version automatically from `package.yml.version` and the current workspace state.

#### 3.1 Inputs considered

On each `save <pkg>`:

- Read:
  - `package.yml.version` → `S` (next intended stable).
  - `package.index.yml.workspace.version` if present → `lastWorkspaceVersion`.
  - `workspaceHash` derived from `cwd`.

- Compute:
  - `wipVersion = S-wip.<timestamp>.<workspaceHash>`.

#### 3.2 Normal case: `package.yml` and index agree on version line

Examples:

- `package.yml.version = 1.2.3`, `package.index.yml.workspace.version` is:
  - Missing (first save), or
  - A WIP like `1.2.3-wip.123`, or
  - A stable like `1.2.3` from a previous `pack`.

Behavior:

- Continue the WIP stream on that same stable line:
  - Generate a **new WIP version**: `1.2.3-wip.<newTimestamp>.<workspaceHash>`.

- Effect:
  - `package.yml.version` **remains `S`** (e.g. `1.2.3`).
  - `package.index.yml.workspace.version` is set to the new `wipVersion`.
  - A new `package.link.yml` is written for this WIP version.
  - Older WIPs for the **same `workspaceHash`** are cleaned up (registry link entries).

#### 3.3 Out-of-sync case: user manually changes `package.yml.version`

Scenario:

- Previous state:
  - `package.index.yml.workspace.version = 1.2.3-wip.123` or `1.2.3`.
- User edits:
  - `package.yml.version = 3.0.0` (or any different stable).
- User runs `save`.

Behavior:

- The CLI recomputes:
  - `S = 3.0.0`.
- Treat this as a **reset to a new version line**.
- Log a clear message, for example:
  - “Detected mismatch: `package.yml` version is `3.0.0`, last workspace version was `1.2.3-wip.123`. Starting a new WIP sequence from `3.0.0-wip.*` based on `package.yml`.”
- Generate `wipVersion = 3.0.0-wip.<timestamp>.<workspaceHash>`.

- Writes:
  - `package.yml.version` stays at the user-specified `3.0.0`.
  - `package.index.yml.workspace.version` becomes `3.0.0-wip.*`.
  - Registry link file is updated accordingly, with old WIPs for this `workspaceHash` cleaned up.

- This rule is **the same** whether the old `lastWorkspaceVersion` was WIP or stable:
  - In all mismatched cases, `package.yml` wins and the WIP stream restarts from `package.yml.version`.

---

### 4. `pack` Command Versioning Behavior

`pack <pkg>` is the “promote to stable copy” operation.

- Inputs:
  - `package.yml.version = S` (next intended stable).
  - `package.index.yml.workspace.version` (might be WIP or a previous stable).
  - **No `--bump` option**: version bumping is expressed by the user editing `package.yml.version` directly.
  - **No `<pkg>@<version>` syntax**: `pack` always uses `package.yml.version` as the target stable version; users change the target by editing `package.yml.version`, not via `@<version>` on the CLI.

- Behavior:
  - **Target stable version**:
    - `pack` **always publishes exactly `S`** as the stable version.
    - Example:
      - `package.yml.version = 1.2.3`.
      - WIPs are `1.2.3-wip.*`.
      - `pack` publishes `1.2.3` as stable.
    - If there is no existing WIP stream, `pack` still publishes `S` directly from the current workspace files.
  - **Registry**:
    - Copies full package contents to `registry/<pkg>/<S>/...`.
  - **Index**:
    - Sets `package.index.yml.workspace.version` to that stable version `S`.
    - Refreshes `files` mapping based on the just-packed snapshot.
  - **WIP cleanup**:
    - Removes this workspace’s WIP link entries (`package.link.yml`) for that package, using `workspaceHash`.

- `package.yml.version` after `pack`:
  - After a successful `pack` of `S`:
    - Compute `Snext = patch(S)`.
    - Automatically update `package.yml.version` to `Snext`, preparing the workspace for the next development cycle.
    - Log a clear message, for example:
      - “Packed `<name>@S`. Updated `package.yml.version` to `Snext` for the next cycle.”
  - If `pack` fails, `package.yml.version` MUST NOT be changed.

---

### 5. Invariants and UX Guarantees

- **Priority**:
  - `package.yml.version` is always the **canonical** version declaration for the **next** stable release.
  - `package.index.yml.workspace.version` is always **derived**, never the authority (it reflects the last WIP or last packed stable).

- **Semver correctness**:
  - For any stable `S` and its associated WIP stream:
    - `S-wip.* < S` always holds.

- **User mental model**:
  - “The version in `package.yml` is the **next stable** I’m working toward.”
  - “`save` creates WIP versions as pre-releases of that version (`<version>-wip.*`) and keeps index/registry pointers in sync.”
  - “`pack` publishes that exact version, records it as the last packed stable, and then automatically bumps `package.yml.version` to the next patch so I don’t accidentally keep saving WIPs against an already released version.”

- **Workspace isolation**:
  - WIP registry entries are always scoped by `workspaceHash`, and `save`/`pack` clean up WIPs only for the current workspace.



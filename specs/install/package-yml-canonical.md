### `package.yml` as Canonical for Install

This document defines how `.openpackage/package.yml` interacts with the `install` command, and what it means for `package.yml` to be the **canonical** declaration of dependency intent.

The aim is to make behavior predictable and avoid “CLI overrides” that silently diverge from `package.yml`.

---

## 1. Canonical responsibility

- **Canonical source of truth**:
  - For the **current workspace**, `.openpackage/package.yml` is the **only authoritative declaration** of:
    - Which **direct dependencies** exist.
    - Which **version ranges** apply to those dependencies.
  - This applies to both:
    - `packages` (regular dependencies).
    - `dev-packages` (development dependencies).

- **Install’s role**:
  - `install` **never changes intent by itself**:
    - It does **not mutate existing ranges** in `package.yml` unless explicitly asked by a future higher-level command (e.g. an `upgrade`).
    - It **materializes or refreshes** dependencies so the workspace matches the declared intent.

---

## 2. Direct vs transitive dependencies

- **Direct dependencies**:
  - Declared in the workspace `.openpackage/package.yml`.
  - Fully controlled by the user.
  - Canonical range comes from `package.yml`.

- **Transitive dependencies**:
  - Declared in other packages’ `package.yml` files (inside registry packages).
  - Resolved entirely by the dependency resolver according to version constraints; they do not appear in the root `package.yml`.
  - `install` may upgrade them within the declared ranges, but they are **not canonical at the root level**.

---

## 3. Mapping CLI input to canonical ranges

### 3.1 Fresh packages (not yet in `package.yml`)

- **Case A – `opkg install <name>`**:
  - No explicit range is provided.
  - The CLI:
    - Resolves **latest suitable version** from local+remote (see `version-resolution.md`).
    - Adds `<name>` to `package.yml` with a **default range derived from that version**, e.g.:
      - `^S` where `S` is the selected stable version.
      - If only WIP/pre-release exists, the policy may:
        - Use an **exact WIP version** in `package.yml`, or
        - Use a range that explicitly includes that pre-release.

- **Case B – `opkg install <name>@<spec>`**:
  - `<spec>` is treated as the **initial canonical range** for `<name>`.
  - The resolver:
    - Uses `<spec>` as the range for selecting a concrete version.
    - On success:
      - Installs the selected version.
      - **Persists `<spec>` as-is** in `package.yml` (except for any normalization strictly required by the version-range parser).

### 3.2 Existing packages (already in `package.yml`)

- Let **`R_pkg`** be the range string stored in `package.yml` for `<name>`.

- **Case C – `opkg install <name>`**:
  - The canonical range is **`R_pkg`**.
  - Any pre-existing installed version is considered **derived from `R_pkg`**.
  - Behavior:
    - Resolve the **latest-in-range** version from local+remote using `R_pkg`.
    - If a newer satisfying version exists, **upgrade** the installed version.
    - `R_pkg` itself is **not changed**.

- **Case D – `opkg install <name>@<spec>`**:
  - CLI `<spec>` is treated as a **constraint hint**, **not** a new canonical source.
  - The system:
    - Parses both `<spec>` and `R_pkg`.
    - Checks for **compatibility**:
      - Informally: `<spec>` must not *contradict* `R_pkg`.
      - Implementation may use:
        - A simple rule (e.g. they must be **semver-equivalent** or one must semantically be a subset of the other).
    - Outcomes:
      - If `<spec>` is **compatible** with `R_pkg`:
        - Proceed using **`R_pkg` as the effective range** for resolution.
        - Optionally log a message: “Using version range from package.yml (`R_pkg`); CLI spec `<spec>` is compatible.”
      - If `<spec>` is **incompatible** with `R_pkg`:
        - **Fail with a clear error**, for example:
          - “Version spec `<spec>` conflicts with `package.yml` range `R_pkg` for `<name>`. Edit `.openpackage/package.yml` if you intend to change the dependency line.”
        - No installs or upgrades are performed.

---

## 4. When and how `package.yml` is mutated

### 4.1 Allowed mutations by `install`

- **Adding new dependencies**:
  - `install` may **append** new entries to:
    - `packages` (by default), or
    - `dev-packages` (when `--dev` is provided).
  - It **must not**:
    - Remove existing entries.
    - Rewrite existing version ranges.

- **Rewriting malformed entries (edge case)**:
  - If `package.yml` contains a **syntactically invalid** version range for a dependency that the user is trying to install:
    - The primary expectation is to **fail with a clear error** and ask the user to fix the YAML.
    - Auto-rewriting malformed entries should **not** happen silently.

### 4.2 Mutations by other commands

- `install` assumes that:
  - `save` / `pack` and any future `upgrade`-like commands are responsible for:
    - Intentionally changing version lines.
    - Bumping base versions for stable lines.
  - Therefore, `install` **never auto-bumps** the declared ranges in `package.yml`.

- **Auto-tracking of workspace-owned packages (`save` / `pack`)**:
  - When a package developed in the current workspace is first added as a dependency:
    - `save` / `pack` persist a **default caret range** derived from the new stable, e.g. `^1.2.3`.
  - On subsequent `save` / `pack` operations for that same package:
    - Let `R_pkg` be the existing range in `package.yml` and `S_new` the new stable base version (e.g. `2.0.0`).
    - **Special case: Prerelease-to-stable transition during `pack`**:
      - If `R_pkg` includes explicit prerelease intent (e.g. `^1.0.0-0`) and `S_new` is a stable version on the same base line (e.g. `1.0.0`):
        - Then `pack` **updates** `R_pkg` to a stable range (e.g. `^1.0.0`) to reflect the transition from prerelease to stable.
      - This exception **only applies** when transitioning from a prerelease-intent constraint to a stable target; subsequent stable version changes within the stable range do not update `R_pkg`.
      - For prerelease-intent ranges, `save` operations (which produce prerelease versions) **never** update the constraint, preserving the prerelease intent.
    - If `S_new` **already satisfies** `R_pkg` (e.g. `R_pkg = ^1.0.0`, `S_new = 1.0.1`):
      - **The constraint is left unchanged**; `save` / `pack` do not rewrite `R_pkg`.
    - If `S_new` is **outside** `R_pkg` (e.g. `R_pkg = ^1.0.0`, `S_new = 2.0.0`):
      - `save` / `pack` may **auto-update** the dependency line in `package.yml` to a new caret range `^S_new` to keep the workspace tracking the new stable line.
  - This auto-tracking behavior:
    - Applies only to dependencies managed via `save` / `pack` for workspace-owned packages.
    - Never changes constraints that already include the new stable version (except for the prerelease-to-stable transition exception above).

---

## 5. Conflict scenarios & UX

### 5.1 CLI vs `package.yml` disagreement

- **Scenario**:
  - `package.yml`: `foo: ^1.2.0`
  - User runs: `opkg install foo@2.0.0`

- **Behavior**:
  - Detect that `<spec> = 2.0.0` is **outside** `^1.2.0`.
  - Fail with a message similar to:
    - “Requested `foo@2.0.0`, but `.openpackage/package.yml` declares `foo` with range `^1.2.0`. Edit `package.yml` to change the dependency line, then re-run `opkg install`.”

### 5.2 Existing install but changed `package.yml`

- **Scenario**:
  - Previously: `foo` declared as `^1.2.0`, installed `1.3.0`.
  - User edits `package.yml` to `foo: ^2.0.0`.
  - Then runs `opkg install` or `opkg install foo`.

- **Behavior**:
  - Treat the new `^2.0.0` as **canonical**.
  - Compute latest-in-range from local+remote under `^2.0.0`.
  - Install or upgrade to that version, even if it requires pulling from remote.
  - Optionally log a message noting that the base line changed, similar to the save/pack reset messages (but this is informational only).

### 5.3 Dependency removed from `package.yml`

- **Scenario**:
  - `foo` used to be in `package.yml`.
  - User removes `foo` from both `packages` and `dev-packages`.
  - `foo` may still be installed under `.openpackage` from a previous state.

- **Behavior on `opkg install`**:
  - `foo` is no longer considered a **direct dependency** of the workspace.
  - **No new installs/upgrades** of `foo` are performed as part of the root install.
  - Cleanup of now-unused packages is handled by `uninstall` / pruning flows, not by `install`.

---

## 6. Summary invariants

- **I1 – Canonical intent**:
  - For direct dependencies, **`package.yml` is always the source of truth**.
  - CLI specs cannot silently override it; at most they can:
    - Seed new entries (fresh installs).
    - Act as compatibility hints for existing entries.

- **I2 – Install does not rewrite intent**:
  - `install`:
    - Does **not mutate existing version ranges**.
    - Only **adds new entries** when installing fresh dependencies.

- **I3 – Explicit edits for semantic changes**:
  - To change which major version line a dependency tracks, the user **edits `package.yml`**, not `install` flags.
  - This mirrors the mental model from the save/pack specs:
    - “`package.yml` version is what I’m working toward; commands operate relative to that declaration.”



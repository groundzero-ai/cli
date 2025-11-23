### Install Command – Stage 1 Plan: CLI Shapes & Resolution Modes

This plan defines the first implementation stage for the new `install` behavior, focused on **CLI surface**, **resolution modes** (including `--local`), and **high-level control flow**, before deeper resolver and canonicalization work in Stage 2.

Refer to:
- `../install-behavior.md`
- `../package-yml-canonical.md`
- `../version-resolution.md`

---

### 1. Goals for Stage 1

- **G1 – Stable CLI contract**:
  - Align `opkg install` CLI shapes with `install-behavior.md`:
    - `opkg install`
    - `opkg install <name>`
    - `opkg install <name>@<spec>`
- **G2 – Explicit resolution modes**:
  - Introduce a **single, explicit resolution mode** concept that covers:
    - **default** (local+remote, as per specs),
    - **remote-primary** (`--remote`),
    - **local-only** (`--local`, per feedback).
- **G3 – Clean command wiring**:
  - Ensure `src/commands/install.ts` routes arguments, options, and resolution modes cleanly into the core install flow, without yet changing the deep resolver semantics (which will be handled in Stage 2).
- **G4 – Defer WIP content resolution changes**:
  - Stage 1 does **not** change how content is loaded for selected versions (including WIPs).
  - Link-based WIP content resolution via `package.link.yml` is implemented in **Stage 2** once version selection and canonical behavior are in place.

---

### 2. CLI Options and Modes

#### 2.1 Add `--local` flag

- **New option** in `setupInstallCommand` (in `src/commands/install.ts`):
  - `--local` – **force local-only version selection and installs**:
    - Interpretation: *“Resolve and install using **only local registry versions**, ignoring remote metadata and remote pulls.”*
    - Mirrors `--remote` but in the opposite direction:
      - `--remote`: **remote-primary**, remote metadata authoritative.
      - `--local`: **local-only**, remote completely skipped.

- **Mutual exclusivity**:
  - If both `--remote` and `--local` are provided:
    - Fail early with a clear error, e.g.:
      - “`--remote` and `--local` cannot be used together. Choose one resolution mode.”

#### 2.2 Resolution mode abstraction

- Introduce an internal enum/type (not necessarily exported) in `install.ts`, e.g.:
  - `type InstallResolutionMode = 'default' | 'remote-primary' | 'local-only';`

- Determine mode in `installCommand`:
  - If `options.remote` is truthy:
    - `mode = 'remote-primary'`.
  - Else if `options.local` is truthy:
    - `mode = 'local-only'`.
  - Else:
    - `mode = 'default'`.

- Thread this mode into `installPackageCommand` (via `InstallOptions` or a new argument):
  - **Stage 1**: Plumb the mode through without deeply changing behavior.
  - **Stage 2**: Make `mode` drive concrete version-resolution choices as per `version-resolution.md`.

---

### 3. Command Shapes & High-Level Flow

#### 3.1 Bulk install: `opkg install`

- Keep the overall structure of `installAllPackagesCommand`, but make responsibilities explicit:
  - Reads `.openpackage/package.yml` (created if absent) as **canonical declarations** of direct dependencies (see Stage 2 for stricter invariants).
  - Calls `installPackageCommand` **once per declared dependency**, passing:
    - Dependency name.
    - Any canonical range from `package.yml` (as `versionConstraint`).
    - The computed `resolutionMode`.

- Stage 1 changes:
  - Ensure `installAllPackagesCommand` receives `resolutionMode` and passes it down (likely via `options`).
  - Update logging/messages so they clearly indicate:
    - Whether `--local` / `--remote` mode is in effect for the session.

#### 3.2 Single package: `opkg install <name>` / `<name>@<spec>`

- Maintain the existing parsing via `parsePackageInput`, but separate responsibilities:
  - **Parse CLI input** into `{ name, cliSpec }`.
  - **Stage 1**:
    - Still pass `cliSpec` as the `version` argument into `installPackageCommand`.
    - Do **not yet implement** the full canonical-vs-CLI reconciliation (this is Stage 2).
  - **Stage 2** will:
    - Look up existing entries in `package.yml`.
    - Decide whether this is a **fresh dependency** or **existing dependency**.
    - Enforce compatibility rules between `cliSpec` and canonical range.

- Stage 1 changes limited to wiring:
  - Ensure `resolutionMode` is determined once per CLI invocation and passed through consistently.
  - Keep the signatures of `installCommand` and `installPackageCommand` stable enough to support Stage 2 changes with minimal breakage.

---

### 4. Integration in `installPackageCommand`

Stage 1 aims to **plumb resolution mode** through `installPackageCommand` without fully changing semantics.

- Update signature:
  - Option A: Extend `InstallOptions` with a field like `resolutionMode?: InstallResolutionMode;`.
  - Option B: Add a separate parameter to `installPackageCommand`.
  - Prefer **Option A** to avoid signature churn and to keep modes available for deeper flows.

- Replace current `scenario` selection logic (local-primary vs remote-primary) with a mode-aware version:
  - **Default mode**:
    - Behavior stays closest to current implementation (local-first with remote for missing deps), to be refined in Stage 2.
  - **`remote-primary` mode** (`--remote`):
    - Continue to use the existing “remote-primary” branch, but mark it explicitly as driven by `resolutionMode`.
  - **`local-only` mode** (`--local`):
    - Stage 1: Short-circuit any remote metadata calls and pulls where easy/safe to do so.
    - Stage 2: Enforce that:
      - Only local versions are considered for version resolution.
      - Remote fetch functions are not invoked at all in this mode.

---

### 5. Validation & Backwards Compatibility

- **CLI compatibility**:
  - Existing commands and flags must continue to work:
    - `opkg install`, `opkg install <name>`, `opkg install <name>@<spec>`.
    - Existing flags: `--dry-run`, `--force`, `--conflicts`, `--dev`, `--platforms`, `--remote`, `--profile`, `--api-key`.
  - `--local` is purely additive.

- **Error handling**:
  - New early error if both `--remote` and `--local` are present.
  - Log/print which mode is active (default / remote / local) for debugging clarity.

- **Tests to target in Stage 1** (scaffolding, not full behavioral tests yet):
  - CLI parsing unit/integration tests for:
    - `--local` alone.
    - `--remote` alone.
    - `--remote` + `--local` → error.
  - Ensure `resolutionMode` is correctly set in `InstallOptions` and observable inside `installPackageCommand` (even if behavior is still mostly unchanged).



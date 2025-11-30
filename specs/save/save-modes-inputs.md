### Save Pipeline – Modes and Inputs

#### 1. Overview

The **save pipeline** is the shared engine behind:

- `opkg save` – creates a **WIP prerelease** snapshot for the current workspace.
- `opkg pack` – promotes the current workspace state to a **stable** snapshot.

Both commands:

- Detect which package to operate on.
- Resolve the effective package name (including scoping and optional rename).
- Compute a target version (WIP vs stable) following `save-pack-versioning.md`.
- Select the set of files that belong to the package.
- Copy those files into the local registry.
- Clean up outdated WIP copies for the current workspace.
- Sync files to platform‑specific layouts (platform sync).

Versioning details are defined in `../save-pack-versioning.md`.

---

#### 2. Modes

The pipeline runs in one of two **modes**:

##### WIP mode (`save`)

- Always produces a **WIP prerelease** version derived from the stable line in `package.yml`.
- May optionally auto‑bump `package.yml.version` to the next patch after a stable cycle, per `../save-pack-versioning.md`.

##### Stable mode (`pack`)

- Produces a **stable** version exactly equal to the current `package.yml.version`.
- Never mutates `package.yml.version`.

---

#### 3. Inputs

- **Working directory (`cwd`)** – establishes the workspace.
- **Optional package name argument** – may be omitted (context detection) or provided explicitly.

---

#### 4. Flags

- **`force`**
  - In WIP mode: can suppress prompts and allow overwriting existing WIP versions.
  - In stable mode: allows overwriting existing stable registry entries.
- **`rename <newName>`** – optional new package name to apply during this pipeline run.


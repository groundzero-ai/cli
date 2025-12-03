### Save Pipeline – Registry Writes and Platform Sync

#### 1. Overview

This document covers the final stages of the save pipeline: version/index handling, registry writes, WIP cleanup, and platform sync.

---

#### 2. Version and Index Handling

The pipeline follows these principles (see `../save-pack-versioning.md` for full details):

- The version declared in **`package.yml`** is the **canonical "next stable"** version.
- The **WIP or last stable version** recorded for this workspace lives in `package.index.yml` under `workspace.version`.
- WIP versions are always **pre‑releases derived from the stable line**, including:
  - A time component, and
  - A workspace hash component.

##### On WIP saves

- A new WIP version is computed from the current stable line.
- `package.index.yml` is updated with:
  - `workspace.version` (the exact WIP version).
  - `workspace.hash` (derived from `cwd`).

##### On stable packs

- The stable version is always exactly the value in `package.yml.version`.
- `package.index.yml.workspace.version` is updated to that stable version.

##### Version conflicts

- When `package.yml.version` and the last workspace version disagree, the **`package.yml` version wins**, and the WIP stream restarts from that version.

---

#### 3. Registry Writes

For both modes, once a target version is chosen and content files are resolved:

- The pipeline creates a **full copy** of the package in the local registry under:

  ```
  ~/.openpackage/registry/<finalName>/<targetVersion>/...
  ```

- If a directory already exists for that version:
  - It is fully cleared before writing new contents (unless stable mode is disallowed by a non‑`force` duplicate check).

---

#### 4. WIP Cleanup

##### On WIP saves

After a successful copy:

- The pipeline scans the local registry for WIP versions of the same package that are associated with the current workspace hash.
- All such WIP versions are removed, except the newly created one.

##### On stable packs

After a successful copy:

- The pipeline may also remove WIP versions for this workspace to keep only the stable copy, as described in `../save-pack.md` and `../save-pack-versioning.md`.

---

#### 5. Storage Guarantees

These steps ensure that:

- Stable and WIP versions are both stored as **full, independent copies**.
- Registry storage does not accumulate unbounded, per‑workspace WIP state.

---

#### 6. Platform Sync

After the registry copy succeeds, the pipeline performs a **platform sync** pass.

##### Purpose

- Applies platform mapping rules to mirror the package's contents into platform‑specific workspaces and files (e.g. editor/IDE integrations, AI platforms, etc.).
- Updates `package.index.yml` to reflect the **actual installed paths** after sync.

##### Operations

Distinguishes between:

- Content that should be created or updated on platforms.
- Content that should be removed when no longer present in the package.

##### Index Updates

After sync completes:

- The `package.index.yml` is updated to include **all platform paths where files were actually created**.
- This differs from the `add` command, which only records the source path.
- Example: If a file was added from `.cursor/commands/test.md`, after sync the index will also include `.opencode/command/test.md` (if that platform is detected and the file was synced).

---

#### 7. Root Package Considerations

Special behavior for the **root package**:

- When operating on the root package (the current directory as the package), the pipeline can explicitly **skip root‑level platform sync** steps where appropriate (for example, to avoid syncing global root files back into themselves).
- Nested packages always participate fully in platform sync; their changes are projected out to supported platforms.

---

#### 8. Platform Sync Timing

The platform sync step is invoked only after:

- Package detection and naming/renaming are complete.
- Version and file selection have succeeded.
- Registry copy has completed without errors.

---

#### 9. Error Reporting

Any failures in platform sync are surfaced to the user as part of the save/pack result, with a summary of created, updated, and removed files per platform.


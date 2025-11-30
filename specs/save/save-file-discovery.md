### Save Pipeline – File Discovery

#### 1. Overview

Before copying a package into the registry, the save pipeline must decide **which files and content** belong to the package. This document covers how candidate files are discovered and organized.

---

#### 2. Candidate Sources

For each save/pack run, the pipeline considers up to four sets of candidates:

##### Local platform candidates

- Files already present in the **package directory** under `.openpackage/packages/<name>/`.
- Excludes:
  - Internal `package.index.yml` metadata.
  - Certain root marker files (e.g. the unified root agents file) that are handled specially.
- Only includes paths that are allowed by the registry path rules (e.g. skip internal or unsupported paths).

##### Workspace platform candidates

- Files discovered in the **workspace** that can map into package registry paths (e.g. documentation, rules, platform‑specific content).
- Each discovered file carries:
  - A target registry path.
  - Its full workspace path.
  - A modification time (mtime).
  - Optional platform tag (e.g. a specific platform associated with that file).

##### Local root candidates

- Root‑level documentation files that already exist as part of the package (e.g. `AGENTS.md` or platform‑specific root docs in the package directory).
- Represent root **sections** for a package inside a shared root file.

##### Workspace root candidates

- Root‑level files in the workspace (outside the package directory) that contain dedicated sections for packages.
- These are discovered and turned into candidates representing just the **package's section body** within the larger root file.

---

#### 3. Candidate Properties

Each candidate includes:

- Its **source** (`local` vs `workspace`).
- The **registry path** it maps to.
- The file content (or section body, for root candidates).
- A content hash for deduplication.
- The last modification time.
- Optional **platform** information for platform‑specific variants.

---

#### 4. First Save vs Subsequent Saves

The behavior changes depending on whether the package already has an index (`package.index.yml`) with file mapping information.

##### First save (no index present, or empty file mapping)

- The pipeline focuses on **root files** (shared documentation).
- It:
  - Groups local root candidates and workspace root candidates by registry path.
  - Prompts the user where needed to resolve differences.
  - Writes a unified root file (e.g. `AGENTS.md`) plus any platform‑specific copies.
- The final set of files for the package snapshot is simply the filtered contents of the package directory after root conflicts have been resolved.

##### Subsequent saves (index present with file mappings)

- The pipeline uses `package.index.yml` as a **filter** for which workspace paths are relevant:
  - It builds a set of allowed registry paths and directories based on the index's `files` keys.
  - Workspace candidates whose registry paths are outside this allowed set are ignored, except for root files that are deliberately allowed.
- It merges local and workspace candidates:
  - Local platform candidates.
  - Local root candidates.
  - Workspace platform candidates filtered by allowed registry paths.
  - Workspace root candidates filtered similarly.
- These merged candidates are then grouped and passed through conflict resolution.

This split ensures that:

- The **first** save can safely bootstrap root files and initial content.
- Later saves don't accidentally pull in arbitrary workspace files that were never part of the package.

---

#### 5. Grouping Candidates by Registry Path

For conflict resolution, the pipeline groups candidates by their **normalized registry path**:

- Each **group** contains:
  - At most one `local` candidate (the current package content for that path).
  - Zero or more `workspace` candidates (workspace versions mapping to the same path).
- Root and non‑root paths are handled in the same grouping mechanism, but root groups get special conflict rules (see `save-conflict-resolution.md`).

Grouping allows the pipeline to reason about each registry path independently:

- Whether it has only local content, only workspace content, or both.
- Whether workspace content is identical to or different from the local content.
- Whether there are platform‑specific workspace choices for that path.


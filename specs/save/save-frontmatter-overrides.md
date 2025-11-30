### Save Pipeline – Frontmatter and YAML Overrides

#### 1. Overview

For markdown files, the pipeline manages **frontmatter** and platform‑specific overrides to keep shared metadata centralized while allowing platform-specific behavior.

---

#### 2. Workspace Markdown Candidates

- For each platform, the latest workspace markdown candidate for a given registry path is considered.
- The frontmatter is normalized and separated from the markdown body.

---

#### 3. Universal Frontmatter Extraction

- The pipeline computes frontmatter keys and values that are **identical across all platform entries** for that path.
- These shared keys form the **universal frontmatter** that should live in the base markdown file.

---

#### 4. Platform‑Specific Overrides

For each platform:

- The per‑platform frontmatter is compared against the universal frontmatter.
- Only the **difference** per platform is treated as that platform's override, or omitted if empty.
- Platform overrides are written into **separate YAML files** in a dedicated overrides location.

---

#### 5. Conflicts with Existing Overrides

When a platform override file already exists for a path:

- The pipeline compares existing and new frontmatter, taking modification times into account.
- Typically:
  - If the newer change comes from the workspace, it is preferred by default.
  - When there is a conflicting but not clearly newer override, the user may be prompted to choose between workspace and existing override content where appropriate.

---

#### 6. Resulting Layout

- One universal markdown file with shared frontmatter.
- Zero or more per‑platform YAML override files capturing only the per‑platform differences.

This scheme keeps:

- Shared metadata centralized in the universal file.
- Platform‑specific behavior in small, explicit override files.
- Markdown bodies free from duplication where possible.

---

#### 7. Final File Inclusion Rules

After all conflicts and frontmatter merges are resolved, the pipeline reads the final contents of the package directory and applies a last round of filtering.

##### Excluded

- `package.index.yml`.
- Internal files that are not considered part of the package content.

##### Included

- Paths allowed by the regular registry path rules.
- Root files (the unified root agents file and related root docs).
- YAML override files that represent platform‑specific metadata.
- Root‑level files adjacent to `package.yml` that are intended as part of the package.

---

#### 8. Output

The resulting list of files, with paths relative to the package directory, is what gets:

- Copied into the local registry under the computed version.
- Used to drive platform sync and any subsequent operations in the save pipeline.


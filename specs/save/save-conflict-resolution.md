### Save Pipeline – Conflict Resolution

#### 1. Overview

When multiple candidates exist for the same registry path, the pipeline must decide which content to use. This document describes the conflict resolution rules.

---

#### 2. Resolution Goals

For each group, the pipeline decides:

- Whether any action is needed (no-op when everything matches).
- Which content becomes the **universal** package content for that registry path.
- Which workspace candidates, if any, should be treated as **platform‑specific** sidecars.

---

#### 3. Conflict Types

There are two main flavors of groups:

1. **Root conflicts** (root documentation file for the package)
2. **Regular conflicts** (all other paths)

---

#### 4. Root Conflicts

For the root package section file (e.g. the unified agents document):

##### Ordering and deduplication

- The pipeline orders candidates roughly by:
  - Existing local content first (if any).
  - Workspace candidates by newest modification time, then by display path.
- Deduplicates candidates by content hash.

##### Single candidate

- If there is exactly one unique candidate:
  - That candidate is used as the universal content for the root file.

##### Multiple differing candidates

- If the local candidate is newer than or equal to all workspace candidates:
  - The local candidate is selected automatically.
- Otherwise:
  - With `--force`:
    - The local candidate always wins.
  - Without `--force`:
    - The user is prompted to choose which candidate should become the universal root content.

##### Output

- The chosen root content is written into the package's root file location.
- Platform‑specific root selections (e.g. separate root files for individual platforms) are persisted as separate package files where appropriate.

---

#### 5. Regular Conflicts

For non‑root paths:

##### Ordering and deduplication

- The pipeline again orders and deduplicates candidates.
- Checks whether any workspace candidate actually **differs** from the local candidate.

##### No local candidate

- If the file does not yet exist in the package:
  - The selected workspace candidate becomes the new file content.

##### Identical content

- If local and all workspace candidates have identical content:
  - The group is skipped (no changes).

##### Differences with local candidate

When there are differences and a local candidate exists:

- If the local candidate is newer or as new as any workspace candidate:
  - The local version wins silently (no prompt).
- If a newer workspace candidate exists:
  - Without `--force`:
    - The user is prompted to choose which candidate should become universal content.
  - With `--force`:
    - The local candidate wins even if workspace content is newer.

---

#### 6. Resolution Principles

In all cases, the goal is to:

- Prefer local content when it is at least as new as workspace content.
- Ask the user only when a newer workspace change would override local content.
- Respect an explicit `--force` override in favor of local content.

---

#### 7. Platform‑Specific Selection

Some workspace candidates are associated with specific platforms (e.g. platform‑specific variants of a shared file).

##### Marking platform-specific candidates

- Before choosing the universal content, the user can be offered a chance to:
  - Mark one or more workspace candidates as **platform‑specific**.
  - These marked candidates will be written to platform‑specific registry paths instead of becoming the universal content.

##### After marking

- The remaining candidates (local + unmarked workspace candidates) participate in universal conflict resolution as described above.
- Marked candidates are saved as platform‑specific sidecars if they are not chosen as the universal content.

##### Use case

This mechanism lets a user:

- Keep a single universal file.
- Simultaneously maintain richer, platform‑specific versions where needed.

---

#### 8. Escalation from YAML Overrides to Full Platform Markdown

When a registry path participates in the frontmatter/YAML override pipeline (e.g. `.openpackage/agents/*.md`) **and** the user marks one or more workspace candidates as platform‑specific during conflict resolution:

- **Universal body update**
  - The universal markdown file keeps its existing frontmatter.
  - If the selected universal candidate’s body differs, only the **markdown body** is updated.
  - Frontmatter for that path continues to be managed by the YAML override pipeline.

- **Escalating a platform to full `.platform.md`**
  - Each marked platform‑specific workspace candidate is written to a platform‑specific markdown path (e.g. `yaml-test.qwen.md`) using the **full candidate content** (frontmatter + body).
  - For root conflicts, only the section body is used (consistent with root handling elsewhere).

- **Interaction with YAML overrides**
  - If a platform has an existing YAML override file (e.g. `yaml-test.qwen.yml`) and is escalated to a full `.platform.md`:
    - The corresponding YAML override file is removed as redundant.
    - That platform is removed from the frontmatter merge plan for that registry path.
  - After escalation, the remaining frontmatter/YAML plans (if any) are applied only for platforms that still use YAML overrides, ensuring universal frontmatter is not recomputed based on escalated full‑markdown variants.


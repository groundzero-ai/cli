### Registry Payload and 1:1 Copy

The **registry payload** for a given version is defined by two layers of rules.

---

#### 1. Static Rules

**Always exclude:**
- `package.index.yml` (workspace-local metadata)
- Anything under `packages/` (nested packages are separate units)

**Always include (cannot be excluded):**
- `.openpackage/package.yml` (package manifest)

**Included by default (removable via manifest `exclude`):**
- Every platform root file declared in `platforms.jsonc` (e.g., `CLAUDE.md`, `WARP.md`, `AGENTS.md`) when it exists
- Any `.openpackage/<universal-subdir>/…` directory (agents, rules, commands, skills, etc.)
- Any root-level content (directories/files at package root, outside `.openpackage/`)

**Everything else starts excluded by default.**

---

#### 2. Manifest Filters

In `package.yml`:

- **`include`** (array): Expands the payload by listing additional glob-like patterns relative to the package root
- **`exclude`** (array): Removes matches after include rules are applied (but never overrides hard includes/excludes)

> **Note**: Newly created nested packages default their `package.yml` to `include: ["**"]`, so they start including all files until the author narrows the list.

---

#### Save and Install Operations

**When saving:**

1. The save pipeline reads files from the package root using the rules above
2. Files are written **unchanged** to: `~/.openpackage/registry/<name>/<version>/...`

**When installing:**

1. The install pipeline loads `pkg.files` from the registry
2. Files are written 1:1 to: `cwd/.openpackage/packages/<name>/...` for local cache
3. Universal content is mapped to platform-specific locations in the workspace

---

#### Package Structure in Registry

Registry copies maintain the same structure as workspace packages:

```text
~/.openpackage/registry/<name>/<version>/
  .openpackage/
    package.yml                # package manifest
    commands/                  # universal content
      test.md
    rules/
      auth.md
  <root-dir>/                  # root-level content (any directory)
    helper.md
  AGENTS.md                    # root files
```

---

#### Guarantees

This system guarantees that:

- The **workspace package**, **local cache**, and **registry version directory** all share the **same tree shape**
- Save and install operations are **pure copies** at the package boundary, without structural rewrites
- Packages can be moved between locations (workspace root ↔ nested ↔ registry) without modification


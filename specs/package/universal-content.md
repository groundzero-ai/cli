### Universal Content

#### Universal Content vs. Root-Level Content

Packages contain two types of content:

| Type | Location | Description | Install Behavior |
|------|----------|-------------|------------------|
| **Universal content** | `<package-root>/.openpackage/<subdir>/` | Platform-normalized files | Mapped to platform-specific paths |
| **Root-level content** | `<package-root>/<path>` (outside `.openpackage/`) | Any files/dirs at package root | Copied 1:1 to same relative path |

---

#### Universal Content Layout under `.openpackage/`

Inside `.openpackage/`, each universal subdir is canonical:

```text
<package-root>/
  .openpackage/
    package.yml                # package manifest
    agents/
      <name>.md                # universal markdown
      <name>.<platform>.md     # platform-suffixed markdown (optional)
      <name>.<platform>.yml    # YAML override for frontmatter (optional)
    rules/
      ...
    commands/
      ...
    skills/
      ...
    <custom-subdirs>/          # any additional subdirs
      ...
```

**Definitions:**

- **Universal markdown**:
  - Paths like `.openpackage/agents/foo.md`
  - Contains shared body and (after save) shared frontmatter
  
- **Platform-suffixed markdown**:
  - Paths like `.openpackage/agents/foo.<platform>.md`
  - Represents platform-specific variants of a universal file
  
- **YAML override files**:
  - Paths like `.openpackage/agents/foo.<platform>.yml`
  - Contains only the **per-platform difference** in frontmatter

---

#### Root-Level Content (Outside `.openpackage/`)

Root-level content lives at the package root, **not** under `.openpackage/`:

```text
<package-root>/
  .openpackage/
    ...                        # universal content inside
  <root-dir>/                  # any root-level directory
    helper.md
    prompts/
      system.md
  AGENTS.md                    # root files
  CLAUDE.md
  README.md
```

Root-level content:
- Is stored and copied **without transformation**
- Maps to the **same relative path** in the workspace
- Includes any directories at the package root, platform root files (`AGENTS.md`, `CLAUDE.md`), etc.

---

#### Registry Paths (Keys in `package.index.yml`)

Registry paths are **relative to the package root**:

| Content Type | Example Registry Path |
|--------------|----------------------|
| Universal content | `.openpackage/commands/test.md` |
| Root-level content | `<dir>/helper.md` |
| Root files | `AGENTS.md` |

**Rules:**

- Universal subdir content **always** has `.openpackage/` prefix
- Root-level content uses its natural path (no prefix)
- Root files use their filename directly

---

#### Install Mapping Examples

**Universal content** (platform-specific mapping):

| Registry Path | Installed Paths |
|---------------|-----------------|
| `.openpackage/commands/test.md` | `.cursor/commands/test.md`, `.opencode/commands/test.md`, etc. |
| `.openpackage/rules/auth.md` | `.cursor/rules/auth.mdc`, etc. |

**Root-level content** (1:1 mapping):

| Registry Path | Installed Path |
|---------------|----------------|
| `<dir>/helper.md` | `<dir>/helper.md` |
| `AGENTS.md` | `AGENTS.md` |

---

#### Consistent Layout Across Locations

These layouts apply identically whether the package lives at:

- **Workspace root**: `cwd/` (content at `cwd/.openpackage/...`)
- **Nested package**: `cwd/.openpackage/packages/<name>/` (content at `cwd/.openpackage/packages/<name>/.openpackage/...`)
- **Registry**: `~/.openpackage/registry/<name>/<version>/` (content at `.../.openpackage/...`)

---

#### Frontmatter and Overrides

In the canonical structure:

- Each universal markdown file (`.openpackage/<subdir>/<name>.md`) is the **single source of truth** for:
  - Markdown body
  - Shared frontmatter keys/common metadata

- Platform overrides live alongside their universal file:

```text
.openpackage/agents/foo.md              # universal body + shared frontmatter
.openpackage/agents/foo.claude.yml      # CLAUDE-specific frontmatter diff
.openpackage/agents/foo.claude.md       # optional CLAUDE-specific markdown body
```

The save pipeline:

1. Normalizes workspace markdown and computes:
   - Universal frontmatter to keep in `foo.md`
   - Per-platform differences to write as `foo.<platform>.yml`
2. Writes override files into the `.openpackage/<subdir>/` tree


### Package Root Layout

Every package root directory (workspace root, nested, or registry) uses this structure:

```text
<package-root>/
  .openpackage/                # REQUIRED – package content directory
    package.yml                # REQUIRED – package manifest (marks this as a package)
    package.index.yml          # OPTIONAL – install/index metadata (never in registry payload)
    agents/                    # universal content subdirs
    rules/
    commands/
    skills/
    <custom-subdirs>/          # any additional universal content
  <root-dirs>/                 # OPTIONAL – root-level content (outside .openpackage/)
  AGENTS.md                    # OPTIONAL – universal root file
  <other-root-files>           # OPTIONAL – platform-specific root files (e.g. CLAUDE.md)
  README.md                    # OPTIONAL – documentation
  packages/                    # OPTIONAL – nested packages (workspace root only)
```

---

#### Two Types of Package Content

1. **Root-level content** (outside `.openpackage/`):
   - Any files/directories at the package root (e.g., `<dir>/foo.md`, `AGENTS.md`, `CLAUDE.md`)
   - Live directly at the package root level, outside `.openpackage/`
   - Stored and mapped without transformation

2. **Universal content** (inside `.openpackage/`):
   - Platform-normalized files stored under `.openpackage/<subdir>/`
   - Source files like `.cursor/commands/test.md` are normalized to `.openpackage/commands/test.md`
   - Mapped to platform-specific locations during install (e.g., `.cursor/commands/`, `.opencode/commands/`)

---

#### Key Invariants

- **`.openpackage/package.yml`** marks a directory as a package root.
- **Universal content** (rules, agents, commands, skills, custom subdirs) lives **under `.openpackage/`**.
- **Root-level content** (any directories/files outside `.openpackage/`) lives **at the package root** (sibling of `.openpackage/`).
- **Nested packages** live under `packages/` and are treated as **independent packages**.
- The **same structure** applies to workspace root packages, nested packages, and registry copies.

---

#### Concrete Examples

**Workspace root package** (package root = `cwd/`):

```text
cwd/
  .openpackage/
    package.yml
    package.index.yml
    commands/
      test.md
    rules/
      auth.md
  <root-dir>/                  # any root-level directory
    helper.md
  AGENTS.md
```

**Nested package** (package root = `cwd/.openpackage/packages/foo/`):

```text
cwd/.openpackage/packages/foo/
  .openpackage/
    package.yml
    package.index.yml
    commands/
      test.md
  <root-dir>/                  # any root-level directory
    helper.md
```


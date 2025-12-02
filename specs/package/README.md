### Canonical Universal Package Structure

This directory contains the canonical on-disk structure spec for OpenPackage packages, split into focused documents:

- **Root layout**: `package-root-layout.md` – Package directory structure and content types
- **Universal content**: `universal-content.md` – Platform-normalized content under `.openpackage/`
- **Package index**: `package-index-yml.md` – File mapping and `package.index.yml` structure
- **Registry payload and 1:1 copy rules**: `registry-payload-and-copy.md` – What gets included in packages
- **Nested packages and parent packages**: `nested-packages-and-parent-packages.md` – Multi-package workspaces

---

#### Core Concept: Package Root

A **package root** is any directory containing `.openpackage/package.yml`. This applies to:

- **Workspace root package**: `cwd/` is the package root
- **Nested packages**: `cwd/.openpackage/packages/<name>/` is the package root
- **Registry copies**: `~/.openpackage/registry/<name>/<version>/` is the package root

All package roots have **identical internal structure**:

```text
<package-root>/
  .openpackage/
    package.yml              # marks this as a package
    package.index.yml        # install index (not in registry)
    commands/                # universal content
    rules/
    agents/
    skills/
  <root-dir>/                # root-level content (outside .openpackage/)
  AGENTS.md                  # root files
  README.md
```

---

#### Two Types of Content

| Type | Location | Example |
|------|----------|---------|
| **Universal content** | `.openpackage/<subdir>/` | `.openpackage/commands/test.md` |
| **Root-level content** | At package root (outside `.openpackage/`) | `<dir>/helper.md`, `AGENTS.md` |

**Universal content** is mapped to platform-specific paths during install.  
**Root-level content** is copied 1:1 without transformation.

---

#### Design Goal

A package directory can be **moved or copied 1:1** between:

- Workspace root packages (`cwd/`)
- Nested workspace packages (`cwd/.openpackage/packages/<name>/`)
- Local registry copies (`~/.openpackage/registry/<name>/<version>/`)

…while preserving the same internal layout and invariants.


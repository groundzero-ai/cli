### Nested Packages and Parent Packages

#### Workspace Structure with Nested Packages

```text
<workspace-root>/                              # root package (package root = cwd/)
  .openpackage/
    package.yml                                # root package manifest
    package.index.yml                          # root package index
    commands/                                  # root package universal content
      shared-command.md
    rules/
      shared-rule.md
  <root-dir>/                                  # root package root-level content (any directory)
    workspace-helper.md
  AGENTS.md                                    # root package root file
  packages/                                    # nested packages directory (workspace root only)
    alpha/                                     # nested package (package root = .openpackage/packages/alpha/)
      .openpackage/
        package.yml
        package.index.yml
        commands/
          alpha-command.md
      <root-dir>/                              # nested package root-level content
        alpha-helper.md
    beta/                                      # nested package (package root = .openpackage/packages/beta/)
      .openpackage/
        package.yml
        package.index.yml
        rules/
          beta-rule.md
```

---

#### Key Rules

- Each `packages/<name>/` directory is its **own canonical package root**, with:
  - Its own `.openpackage/package.yml` (marks it as a package)
  - Its own `.openpackage/` content directory
  - Its own root-level content (outside `.openpackage/`)

- The **parent root package never inlines** `packages/<name>/` into its own payload.

- Registry entries for `alpha` and `beta` are created **independently** from their respective package roots.

- **Only the workspace root package** can have a `packages/` directory. Nested packages cannot have further nested packages.

---

#### Package Root Locations

| Package Type | Package Root Path |
|--------------|-------------------|
| Workspace root | `cwd/` |
| Nested `alpha` | `cwd/.openpackage/packages/alpha/` |
| Nested `beta` | `cwd/.openpackage/packages/beta/` |

---

#### Identical Internal Structure

Both root and nested packages have **identical internal structure**:

```text
<package-root>/
  .openpackage/
    package.yml
    package.index.yml
    <universal-subdirs>/
  <root-level-content>/
  <root-files>
```

This uniformity ensures packages can be:
- Moved between workspace root and nested locations
- Copied to/from registry without structural changes
- Processed by the same code paths regardless of location


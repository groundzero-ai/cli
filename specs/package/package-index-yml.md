### Package Index File (`package.index.yml`)

The `package.index.yml` file tracks the mapping between package files and their installed workspace locations.

---

#### Location

- **Root package**: `cwd/.openpackage/package.index.yml`
- **Nested package**: `cwd/.openpackage/packages/<name>/.openpackage/package.index.yml`

> **Note**: `package.index.yml` is **never** included in the registry payload. It's workspace-local metadata.

---

#### Structure

```yaml
# This file is managed by OpenPackage. Do not edit manually.

workspace:
  hash: <workspace-hash>
  version: <installed-version>
files:
  <registry-key>:
    - <installed-path>
    - <installed-path>
  <registry-key>:
    - <installed-path>
```

---

#### Registry Keys

Registry keys are **relative to the package root**:

| Content Type | Key Format | Example |
|--------------|------------|---------|
| Universal content | `.openpackage/<subdir>/<file>` | `.openpackage/commands/test.md` |
| Root-level content | `<path>` | `<dir>/helper.md` |
| Root files | `<filename>` | `AGENTS.md` |

---

#### Values (Installed Paths)

Values are **relative to the workspace root (`cwd`)**:

| Content Type | Value Format | Example |
|--------------|--------------|---------|
| Universal content | Platform-specific paths | `.cursor/commands/test.md`, `.opencode/commands/test.md` |
| Root-level content | Same as key | `ai/helper.md` |

---

#### Root Package Skip Logic

For **root packages only**, when a registry key maps to the exact same value, the mapping is **skipped** because:
- The file is already at the correct location
- No installation/syncing needed
- Avoids redundant mappings

**Example**: For a root package, `<dir>/helper.md` → `<dir>/helper.md` is skipped.

---

#### Nested Package Full Mapping

For **nested packages**, all mappings are included because:
- Files live inside the nested package directory
- Need to be mapped OUT to workspace root during install

**Example**: For nested package `foo`:
- File at `.openpackage/packages/foo/<dir>/helper.md`
- Key: `<dir>/helper.md`
- Value: `<dir>/helper.md` (installed at workspace root)

---

#### Complete Examples

**Root package** (`cwd/.openpackage/package.index.yml`):

```yaml
workspace:
  hash: abc123
  version: 1.0.0
files:
  .openpackage/commands/test.md:
    - .cursor/commands/test.md
    - .opencode/commands/test.md
  .openpackage/rules/auth.md:
    - .cursor/rules/auth.mdc
  # Note: <dir>/helper.md is SKIPPED (maps to itself)
```

**Nested package** (`cwd/.openpackage/packages/foo/.openpackage/package.index.yml`):

```yaml
workspace:
  hash: abc123
  version: 1.0.0
files:
  .openpackage/commands/test.md:
    - .cursor/commands/test.md
    - .opencode/commands/test.md
  <dir>/helper.md:
    - <dir>/helper.md
  AGENTS.md:
    - AGENTS.md
```

---

#### Add Command Examples

| Command | Package | Stored At | Registry Key | Values |
|---------|---------|-----------|--------------|--------|
| `opkg add foo <dir>/foo.md` | Nested `foo` | `.openpackage/packages/foo/<dir>/foo.md` | `<dir>/foo.md` | `<dir>/foo.md` |
| `opkg add foo .cursor/test/foo.md` | Nested `foo` | `.openpackage/packages/foo/.openpackage/test/foo.md` | `.openpackage/test/foo.md` | `.cursor/test/foo.md`, etc. |
| `opkg add <dir>/foo.md` | Root | `.openpackage/<dir>/foo.md` | `<dir>/foo.md` | SKIPPED |
| `opkg add .cursor/test/foo.md` | Root | `.openpackage/test/foo.md` | `.openpackage/test/foo.md` | `.cursor/test/foo.md`, etc. |



### Package Index File (`package.index.yml`)

The `package.index.yml` file tracks the mapping between package files and their **actually installed** workspace locations.

---

#### Location

- **Root package**: `cwd/.openpackage/package.index.yml`
- **Nested package**: `cwd/.openpackage/packages/<name>/.openpackage/package.index.yml`

> **Note**: `package.index.yml` is **never** included in the registry payload. It's workspace-local metadata.

---

#### Excluded Content

The following files are **never** included in the index, even though they may exist in the package:

| File | Reason |
|------|--------|
| `package.yml` | Package manifest; not synced to workspace |
| `.openpackage/package.yml` | Same as above (path variant) |
| `package.index.yml` | Index file itself; workspace-local metadata |

The index only contains entries for content that is **actually synced** to workspace locations.

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

Values are **relative to the workspace root (`cwd`)** and represent **paths that actually exist**:

| Content Type | Value Format | Example |
|--------------|--------------|---------|
| Universal content | Platform-specific paths | `.cursor/commands/test.md`, `.opencode/commands/test.md` |
| Root-level content | Same as key | `ai/helper.md` |

> **Important**: The index only records paths where files **actually exist**. If a file is only installed to one platform (e.g., `.cursor/`), only that path appears in the index—not hypothetical paths for other platforms.

---

#### Index Update Behavior

The index is updated differently depending on the operation:

| Operation | Behavior |
|-----------|----------|
| **Add** | Records only the source path that was used to add the file. If you add `.cursor/commands/test.md`, only that path is recorded. |
| **Save/Sync** | Expands the index to include all platform paths where files were actually created during sync. |
| **Install** | Populates the index with all platform paths where files were installed. |

This ensures the index reflects the **current state** of the workspace, not hypothetical future states.

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

**After `opkg add .cursor/commands/test.md`** (only source path recorded):

```yaml
workspace:
  hash: abc123
  version: 1.0.0-abc123.xyz
files:
  .openpackage/commands/test.md:
    - .cursor/commands/test.md    # Only the source path that exists
```

**After `opkg save`** (all synced paths recorded):

```yaml
workspace:
  hash: abc123
  version: 1.0.0-abc123.xyz
files:
  .openpackage/commands/test.md:
    - .cursor/commands/test.md    # Original source
    - .opencode/command/test.md   # Synced by save
  .openpackage/rules/auth.md:
    - .cursor/rules/auth.mdc
  # Note: package.yml is NOT included (it's the manifest, not synced content)
  # Note: <dir>/helper.md is SKIPPED for root packages (maps to itself)
```

**Nested package** (`cwd/.openpackage/packages/foo/.openpackage/package.index.yml`):

```yaml
workspace:
  hash: abc123
  version: 1.0.0
files:
  .openpackage/commands/test.md:
    - .cursor/commands/test.md
    - .opencode/command/test.md
  <dir>/helper.md:
    - <dir>/helper.md
  AGENTS.md:
    - AGENTS.md
```

---

#### Add Command Examples

When adding files, the index only records the **source path that exists**:

| Command | Package | Stored At | Registry Key | Values (in index) |
|---------|---------|-----------|--------------|-------------------|
| `opkg add foo <dir>/foo.md` | Nested `foo` | `.openpackage/packages/foo/<dir>/foo.md` | `<dir>/foo.md` | `<dir>/foo.md` |
| `opkg add foo .cursor/test/foo.md` | Nested `foo` | `.openpackage/packages/foo/.openpackage/test/foo.md` | `.openpackage/test/foo.md` | `.cursor/test/foo.md` (only source) |
| `opkg add <dir>/foo.md` | Root | `.openpackage/<dir>/foo.md` | `<dir>/foo.md` | SKIPPED |
| `opkg add .cursor/test/foo.md` | Root | `.openpackage/test/foo.md` | `.openpackage/test/foo.md` | `.cursor/test/foo.md` (only source) |

> **Note**: After `opkg save`, the index will expand to include other platform paths (e.g., `.opencode/test/foo.md`) once those files are actually synced.



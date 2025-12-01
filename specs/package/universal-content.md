### Universal Content

#### Universal Content Layout under `.openpackage/`

Inside `.openpackage/`, each universal subdir is canonical:

```text
<package-root>/
  .openpackage/
    agents/
      <name>.md              # universal markdown
      <name>.<platform>.md   # platform-suffixed markdown (optional)
      <name>.<platform>.yml  # YAML override for frontmatter (optional)
    rules/
      ...
    commands/
      ...
    skills/
      ...
```

Definitions:

- **Universal markdown**:
  - Paths like `.openpackage/agents/foo.md`.
  - Contain shared body and (after save) shared frontmatter.
- **Platform-suffixed markdown**:
  - Paths like `.openpackage/agents/foo.<platform>.md`.
  - Represent platform-specific variants of a universal file.
- **YAML override files**:
  - Paths like `.openpackage/agents/foo.<platform>.yml`.
  - Contain only the **per-platform difference** in frontmatter for the corresponding universal markdown.

These layouts apply identically whether the package lives under:

- Workspace root: `cwd/.openpackage/…`
- Nested package: `cwd/.openpackage/packages/<name>/.openpackage/…`
- Registry: `~/.openpackage/registry/<name>/<version>/.openpackage/…`

---

#### Registry Paths and Universal Subdirs

The canonical **registry paths** used in indexes and installers always include the `.openpackage/` prefix for universal content:

- Examples:
  - `.openpackage/agents/foo.md`
  - `.openpackage/agents/foo.claude.md`
  - `.openpackage/agents/foo.claude.yml`
  - `.openpackage/rules/auth.md`

Rules:

- Root files (e.g. `AGENTS.md`, `CLAUDE.md`) are **not** under `.openpackage/` and use their natural filenames.
- All universal subdir content (`agents`, `rules`, `commands`, `skills`) **must** live under `.openpackage/<subdir>/…`.
- The installer parses these registry paths to:
  - Map universal content into platform-specific locations.
  - Preserve 1:1 structure when writing local package copies.

---

#### Frontmatter and Overrides in the Canonical Layout

In the canonical structure:

- Each universal markdown file (`.openpackage/<subdir>/<name>.md`) is the **single source of truth** for:
  - Markdown body.
  - Shared frontmatter keys/common metadata.
- Platform overrides live alongside their universal file:

```text
.openpackage/agents/foo.md              # universal body + shared frontmatter
.openpackage/agents/foo.claude.yml      # CLAUDE-specific frontmatter diff
.openpackage/agents/foo.claude.md       # optional CLAUDE-specific markdown body
```

The save pipeline:

- Normalizes workspace markdown and computes:
  - Universal frontmatter to keep in `foo.md`.
  - Per-platform differences to write as `foo.<platform>.yml`.
- Writes override files into the `.openpackage/<subdir>/` tree so they participate in the same 1:1 copy rules as other package files.

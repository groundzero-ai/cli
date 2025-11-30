## Platforms system behavior

### Overview

The platforms system provides a unified way to describe and work with different AI coding platforms (e.g. Cursor, Claude, Gemini) so that OpenPackage can manage platform‑specific rules, commands, agents, and skills consistently.

From a user’s perspective, the platform layer answers:
- **Which platforms are supported in this workspace?**
- **Where do their files live on disk?**
- **Which files belong to which platform (or to the generic `ai` space)?**
- **Which root files (e.g. `CLAUDE.md`) are active, and how are they used?**

All platform definitions (names, directories, root files, and subdirectories) are centralized in `platforms.jsonc`.

Each platform entry in `platforms.jsonc` has the shape:

- `name` (string): Human‑readable display name.
- `rootDir` (string): Platform root directory (e.g. `.cursor`, `.claude`).
- `rootFile?` (string): Optional root file at the project root (e.g. `CLAUDE.md`, `QWEN.md`).
- `subdirs` (object): Map from universal subdir keys (`rules`, `commands`, `agents`, `skills`) to:
  - `path` (string): Directory path under `rootDir`.
  - `readExts` (string[]): Allowed file extensions for discovery.
  - `writeExt?` (string|null): Preferred write extension (null/omitted = preserve original).
- `aliases?` (string[]): Optional CLI aliases that resolve to this platform.
- `enabled?` (boolean): When `false`, the platform exists in config but is treated as disabled.

---

### Platform identities and aliases

- **Platform id**: each platform has a lowercase id (e.g. `cursor`, `claude`, `gemini`) used throughout the CLI. These ids are the top‑level keys in `platforms.jsonc`.
- **Enabled flag**:
  - Platforms are considered **enabled by default**.
  - A platform can be explicitly disabled in `platforms.jsonc` via `enabled: false` (e.g. for experimental or unsupported platforms).
  - Functions that list or iterate platforms only include **enabled** platforms by default, with optional flags to include disabled ones when needed.
- **Aliases**:
  - Each platform can declare **human‑friendly aliases** in its `aliases` array (e.g. `claudecode`, `codexcli`, `geminicli`, `kilocode`, `qwencode`).
  - Aliases are resolved case‑insensitively to a canonical platform id.
  - User‑facing prompts or configs can accept either the platform id or any of its aliases.

**Resolution behavior**

- Given a string input (e.g. from CLI flags, prompts, or config), the system:
  - First treats it as a platform id (after lowercasing).
  - If there is no direct match, it looks it up in the alias map.
  - If neither match, the platform is treated as **unknown**.

---

### Directory layout and universal subdirs

Each platform defines:
- A **root directory** (e.g. `.cursor`, `.claude`, `.gemini`).
- Optional **root file** at the project root (e.g. `CLAUDE.md`, `GEMINI.md`, `QWEN.md`, `WARP.md`, or the shared `AGENTS.md`).
- A set of **universal subdirectories**, which describe where different kinds of content live:
  - `rules` – steering/rules files for a platform.
  - `commands` – command/workflow prompt files.
  - `agents` – agent definitions.
  - `skills` – skill or tool definitions.

For each subdirectory, the platform definition specifies:
- **Path** under the platform root (e.g. `.cursor/rules`, `.factory/droids`, `.kilo/workflows`).
- **Readable extensions**: which file extensions are considered part of that subdir (e.g. `.md`, `.mdc`, `.toml`).
- **Preferred write extension**: which extension is used when the CLI creates or updates files (e.g. cursor rules prefer `.mdc`).

**Examples**

- Cursor:
  - Root dir: `.cursor`
  - Subdirs:
    - `rules` → `.cursor/rules` (reads `.mdc` + `.md`, writes `.mdc`)
    - `commands` → `.cursor/commands` (reads/writes `.md`)
- Claude:
  - Root dir: `.claude`
  - Root file: `CLAUDE.md`
  - Subdirs:
    - `commands` → `.claude/commands`
    - `agents` → `.claude/agents`
    - `skills` → `.claude/skills`

The system exposes a **platform directory map** that, given a working directory, tells callers where each platform’s `rules`, `commands`, `agents`, and `skills` live on disk.

---

### Platform detection

The platforms system can **detect which platforms are present** in a workspace using two signals:

1. **Platform directories**:
   - For each enabled platform, the system checks whether its root directory exists in the current working directory.
   - If the root directory exists, the platform is marked as **present**.

2. **Root files**:
   - For platforms that define a root file (e.g. `CLAUDE.md`, `GEMINI.md`, `QWEN.md`, `WARP.md`), the system checks whether those files exist at the project root.
   - If a root file exists, the corresponding platform is also marked as **present**, even if its standard directory structure is missing.
   - The shared `AGENTS.md` file is treated as **universal** and not attributed to a single platform.

The result is:
- A list of **detection results** (for each platform: `{ name, detected }`).
- A convenience list of **detected platforms only** (used by higher‑level features like setup flows).

---

### Platform‑specific directories and creation

The platforms system provides helpers for:

- **Getting directory paths** for each platform:
  - For each enabled platform, callers can retrieve:
    - The `rules` directory path.
    - Optional `commands`, `agents`, and `skills` directory paths.
    - Optional `rootFile` path, if the platform defines one.
- **Creating missing platform directories**:
  - Given a list of platform ids and a working directory:
    - Ensures the `rules` directory exists for each platform.
    - Creates directories as needed and returns a list of newly created paths.

These helpers allow commands like `opkg init` or platform setup flows to create the necessary folder structure for one or more platforms.

---

### Validating platform structure

For a given platform and working directory, the system can validate:
- That the `rules` directory exists.
- That the configured root file (if any) exists.

It returns:
- A simple `{ valid: boolean, issues: string[] }` result:
  - `valid = true` when the platform’s required directories/files are present.
  - `issues` describing any missing or inconsistent paths.

This is used by higher‑level commands to surface actionable warnings when a platform’s layout is incomplete.

---

### File extension behavior

For each platform’s `rules` subdir, the system exposes:
- The **set of file extensions** that are considered valid rules files for that platform.
  - Example: Cursor rules accept `.mdc` and `.md`, Gemini commands accept `.toml`, etc.
- Higher‑level discovery utilities rely on this to:
  - Filter files by extension when searching for platform content.
  - Decide which files are safe to manage or delete during uninstall/cleanup operations.

---

### Universal subdirectory listing

For any detected platform, the platforms system can return a **normalized list of its subdirectories**:
- Each entry includes:
  - The full directory path.
  - The universal label (`rules`, `commands`, `agents`, `skills`).
  - A short leaf name (last path component) for display.

This list is consumed by:
- Discovery utilities that search for platform‑specific files.
- Uninstall/cleanup flows that remove platform files for a given package.

---

### Platform inference from file paths

The platforms system helps determine which platform a given file belongs to by:

1. **Using path‑to‑platform mappings**:
   - A dedicated mapper converts full workspace paths into a *universal* representation that includes the platform id where possible (e.g. `.cursor/rules/foo.mdc` → platform `cursor` + `rules/foo.mdc`).

2. **Checking for generic workspace directories**:
   - Files that do not live under a known platform root (for example, a conventional `ai/` folder) are treated as workspace-level content rather than being assigned to a specific platform.

3. **Looking at source directory names**:
   - If a file lives under a known platform root directory (e.g. `.cursor`, `.claude`), the system infers that platform from the directory.

4. **Parsing registry paths with platform suffixes**:
   - As a final fallback, the system inspects registry paths for explicit platform suffixes (e.g. `rules/file.cursor.md`) and maps them back to a platform id when possible.

The result is a best‑effort platform id (or a `workspace` classification) for a given file, which other components use to route content to the right registry paths and conflict‑resolution logic.

---

### Root file handling

The platforms system exposes **all known platform root filenames**, derived from the `rootFile` fields in `platforms.jsonc` plus the universal `AGENTS.md`. These are used to:
- Discover root files in the workspace or in the local registry.
- Map root files back to platforms (except for universal `AGENTS.md`).
- Coordinate how content from multiple platform‑specific root files is merged or extracted into a universal view (handled by other utilities).

From a behavioral perspective:
- Platforms that define root files can participate in root‑file‑based flows (e.g. reading/writing `CLAUDE.md`).
- Platforms without root files rely exclusively on their directory layout (`.cursor/rules`, `.kilo/workflows`, etc.).



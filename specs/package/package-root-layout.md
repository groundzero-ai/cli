### Package Root Layout

Every package root directory (workspace, nested, or registry) uses this structure:

```text
<package-root>/
  package.yml                # REQUIRED – package manifest
  package.index.yml          # OPTIONAL – install/index metadata (never stored in registry payload)
  .openpackage/              # REQUIRED – universal content tree
    agents/
    rules/
    commands/
    skills/
  AGENTS.md                  # OPTIONAL – universal root file
  <other-root-files>         # OPTIONAL – platform-specific root files (e.g. CLAUDE.md)
  README.md                  # OPTIONAL – documentation
  packages/                  # OPTIONAL – nested packages (never part of parent package payload)
```

Key invariants:

- **`package.yml`** is always at the **package root** (sibling of `.openpackage/`).
- All **universal content** (rules, agents, commands, skills) lives **under `.openpackage/`**.
- **Nested packages** live under `packages/` but are treated as **independent packages**, not merged into the parent package’s payload.



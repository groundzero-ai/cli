### Registry Payload and 1:1 Copy

The **registry payload** for a given version is defined by two layers of rules:

1. **Static rules**
   - Always exclude:
     - `package.index.yml`
     - Anything under `packages/` (nested packages are separate units)
   - Always include (cannot be excluded):
     - `.openpackage/package.yml` (or the package-local `package.yml`)
   - Included by default (but removable via manifest `exclude`):
     - Every platform root file declared in `platforms.jsonc` (e.g. `CLAUDE.md`, `WARP.md`, `AGENTS.md`) when it exists in the package tree
     - Any `.openpackage/<universal-subdir>/…` directory (agents, rules, commands, skills, etc.) that exists for the package
   - Everything else starts excluded by default.

2. **Manifest filters**
   - `include` (array) expands the payload by listing additional glob-like patterns relative to the package root.
   - `exclude` (array) removes matches after the include rules are applied (but never overrides the hard includes/excludes above).

   > Note: Newly created packages under `.openpackage/packages/<name>/` default their `package.yml` to `include: ["**"]`, so they start out including all files until the author narrows the list. Root workspace `package.yml` files remain untouched unless the user explicitly adds include/exclude entries.

Concretely:

- When saving:
  - The save pipeline reads files from the local package root (root or nested) using these rules.
  - It writes those files **unchanged** under:
    - `~/.openpackage/registry/<name>/<version>/…`
- When installing:
  - The install pipeline loads `pkg.files` from the registry.
  - It writes them 1:1 into:
    - `cwd/.openpackage/packages/<name>/…` for the local cache copy, preserving the canonical layout.

This guarantees that:

- The **workspace package**, **local cache**, and **registry version directory** all share the **same tree shape**.
- Save and install operations are **pure copies** at the package boundary, without structural rewrites.



### Registry Payload and 1:1 Copy

The **registry payload** for a given version is defined as:

- All files under `<package-root>/` **except**:
  - `package.index.yml`
  - Anything under `packages/` (nested packages are separate units)

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



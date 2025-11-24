## Push scoping behavior

### Overview

The `opkg push` command may need to **scope** an unscoped package before pushing it.
Scoping ensures that packages in the remote registry are properly namespaced, e.g. `@user/package`.

This document describes how `push` handles scoping and how it keeps the local registry and workspace in sync.

---

## Scope handling

1. The command looks up `<package-name>` in the local registry.
2. If the name is **unscoped** (e.g. `test`):
   - Authentication is validated using the provided profile/API key.
   - The current username (or profile’s default scope) is resolved.
   - A scoped name is computed (e.g. `@user/test`).
   - The local registry package is renamed to the scoped name using `renameRegistryPackage`.
   - The workspace package is updated (where possible) using `tryRenameWorkspacePackage`, so:
     - `package.yml` and related workspace configuration reflect the new scoped name.
3. After scoping:
   - **All further logic** (version resolution, checks, push) operates on the **scoped name**.

---

## Invariants

- After a successful scope operation:
  - The local registry no longer stores the unscoped name as the active location.
  - The scoped name (e.g. `@user/test`) is the canonical identity used by:
    - Version selection.
    - Tarball creation.
    - Remote upload.
- The workspace is updated where possible so that:
  - Future `save`, `pack`, and `push` operations use the scoped name naturally.
  - References within the workspace (e.g. `package.yml`) do not drift from the registry identity.

---

## Relationship to version selection

- Scoping happens **before** version selection.
- Once the package name is scoped:
  - All lookups for versions (`listPackageVersions`, `packageManager.loadPackage`) use the scoped name.
  - The version-selection rules (see `push-version-selection.md`) are applied strictly to the scoped name.



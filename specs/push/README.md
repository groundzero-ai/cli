### Push Command Specs

This directory contains specifications for the `push` command, with a focus on:

- **Stable-only pushes (no prereleases)**
- **Local-version selection and scoping behavior**
- **Consistent, helpful CLI UX and error messaging**

The documents are intended to be implementation-guiding but not tied to specific modules.

### Files

- **`push-behavior.md`**: Top-level `opkg push` UX and scenarios (CLI shapes, explicit vs implicit versions, no-stable cases).
- **`push-version-selection.md`**: Formal rules for stable-only version selection from the local registry.
- **`push-scoping.md`**: How unscoped packages are scoped (e.g. `test` → `@user/test`) and how workspace renames are handled.
- **`push-errors-and-hints.md`**: Error handling and user-facing hints for both local and remote failures.
- **`push-remote-upload.md`**: Remote upload pipeline once a stable version has been selected.



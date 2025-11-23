### Install Command Specs

This directory contains specifications for the `install` command, with a focus on:

- **Latest-in-range resolution from local + remote registries**
- **`package.yml` as the canonical source of dependency intent**
- **Consistent, minimal, npm-inspired UX**

The documents are intended to be implementation-guiding but not tied to specific modules.

### Files

- **`install-behavior.md`**: Top-level `opkg install` UX and scenarios (CLI shapes, fresh vs existing deps, dev vs prod).
- **`version-resolution.md`**: Formal rules for “latest in range from local+remote”, including WIP vs stable semantics.
- **`package-yml-canonical.md`**: Rules for treating `.openpackage/package.yml` as the canonical declaration for install.



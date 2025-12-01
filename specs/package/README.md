### Canonical Universal Package Structure

This directory contains the canonical on-disk structure spec for OpenPackage packages, split into focused documents:

- **Root layout**: `package-root-layout.md`
- **Universal content**: `universal-content.md`
- **Registry payload and 1:1 copy rules**: `registry-payload-and-copy.md`
- **Nested packages and parent packages**: `nested-packages-and-parent-packages.md`

The goal across all of these docs is that a package directory can be **moved or copied 1:1** between:

- Workspace root packages (`cwd/.openpackage/package.yml`)
- Nested workspace packages (`cwd/.openpackage/packages/<name>/`)
- Local registry copies (`~/.openpackage/registry/<name>/<version>/`)

…while preserving the same internal layout and invariants.



### Save Pipeline – Naming, Scoping, and Renaming

#### 1. Overview

After the package context is known, the pipeline determines the **effective name** and handles any renames or scoping decisions.

---

#### 2. Input Name vs. Detected Configuration

- The **input name** for name resolution comes from:
  - The explicit CLI argument, if present, or
  - The detected package config's `name` when no argument is provided.
- The pipeline **never accepts a version suffix** here:
  - Any `name@version` input is rejected with a clear error.
  - The error instructs the user to change the stable line in `package.yml` instead.

---

#### 3. Explicit Rename (`--rename`)

If `--rename <newName>` is provided:

- The new name must not include a version.
- The pipeline compares the rename target to the input name.
- If they differ:
  - The operation is considered a **rename** with reason `explicit`.
  - The new name becomes the **final package name**.
- If they are the same:
  - No rename is applied; the option is effectively a no‑op.

---

#### 4. Scoping Decision (No Explicit Rename)

When no rename is provided, the pipeline may still **change the name** for scoping reasons:

- If the input name is already scoped, it is used as‑is.
- If the input name is unscoped and scoped variants exist in the local registry:
  - The user is prompted to choose one of:
    - Use an existing scoped variant (e.g. `@user/pkg`).
    - Create a new scoped name (e.g. prompt for `@scope/pkg`).
    - Keep the unscoped name.
  - The chosen name becomes the **final package name**, and any change is recorded as a rename with reason `scoping`.

---

#### 5. UX Feedback

When the final name differs from the input name due to **scoping**, the pipeline prints a confirmation line for the user, e.g.:

> "Using scoped package name '@scope/pkg' for save operation."

---

#### 6. Name Resolution Result

At the end of this phase the pipeline knows:

- `inputName`: the original logical name for the package (without versions).
- `finalName`: the name under which the package will be saved and packed.
- Whether a rename is needed and why (`explicit` vs `scoping`).

---

#### 7. Workspace Rename Effects

When a rename is needed during `save` or `pack`, the workspace is updated so that **on‑disk layout matches the new name**.

##### `package.yml`

- The package's `name` field is updated to the final name.

##### Root files referring to the package

- Root files that contain package markers (e.g. sections in shared documentation) are updated so that markers reference the new name instead of the old one.

##### Root `package.yml` dependencies

- The workspace's root `package.yml` (if present) updates any dependency entries that reference the old name to the new name in both `packages` and `dev-packages`.

##### Nested package directories

- For non‑root packages, the physical package directory under `.openpackage/packages/` is moved to match the new normalized name, unless the directory already uses that layout.
- If directories for the new name already exist, the rename fails with an error explaining the conflict.
- After moving, now‑empty parent directories (such as unused scope directories) may be cleaned up.

---

#### 8. Timing

The rename operation is considered part of the **save/pack workflow**: it happens before versioning, file selection, and registry copy, so downstream steps see the final name consistently.


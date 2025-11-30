### Save Pipeline – Package Context Detection

#### 1. Overview

Before any name or version logic, the pipeline determines which package is being operated on.

---

#### 2. Core Rule

Any directory that contains `.openpackage/package.yml` is considered a **valid package**.

---

#### 3. Detection Behavior

##### No package name argument

- Looks for `.openpackage/package.yml` in the current directory.
- If found:
  - Treats the current directory as the **root package**.
  - Uses its `package.yml` as the configuration source.
- If not found:
  - The pipeline **aborts** with a user‑friendly message describing:
    - That no package was detected at `cwd`.
    - That a `.openpackage/package.yml` file is required.
    - How to initialize a package or specify a name explicitly.

##### Package name argument provided

- First checks whether the **root package** (`.openpackage/package.yml` at `cwd`) has a matching `name`.
  - If yes, the root is the target.
- Otherwise, looks under the **nested packages directory**:
  - Direct directory match under `.openpackage/packages/<name>/package.yml`.
  - If necessary, scans all nested package directories to find a `package.yml` whose `name` field equals the requested package name, even if the directory name differs.
- If no matching package is found:
  - The pipeline **aborts** with a message explaining:
    - The package name was not found.
    - Which locations were checked (root and nested).
    - How to create a new package with that name.

---

#### 4. Package Context Result

Each detected package context includes:

- Package directory.
- Path to `package.yml`.
- Parsed `package.yml` configuration.
- Whether it is the **root package** or **nested**.
- Whether the package's directory is the same as `cwd`.


## Push command behavior

### Overview

The `opkg push` command uploads a local package version from the **local registry** to the **remote registry**.
It is **strictly limited to stable versions** (no prerelease versions like `1.2.3-dev.abc`).

This document focuses on user-facing behavior:
- CLI shapes and arguments.
- Explicit vs implicit version flows.
- What happens when there are no stable versions.
- High-level stable-only guarantees.
- UX examples.

---

## Command synopsis

- **Command**: `opkg push <package-name>`
- **Package syntax**:
  - `<name>` – package name, optionally unscoped.
  - `<name>@<version>` – optional explicit version.

Examples:
- `opkg push my-pack`
- `opkg push @scope/my-pack`
- `opkg push my-pack@1.2.3`

---

## Explicit version behavior: `opkg push <pkg>@<version>`

1. User runs `opkg push <pkg>@<version>`.
2. The CLI treats `<version>` as the **exact** version to push.
3. Behavior:
   - If `<version>` is a **prerelease** (e.g. `1.2.3-beta.1`):
     - The push is **rejected**.
     - The CLI prints:
       - `❌ Prerelease versions cannot be pushed: <version>`
       - `Only stable versions (x.y.z) can be pushed to the remote registry.`
       - `💡 Create a stable version using "opkg pack <package>".`
   - If `<version>` is **not found** in the local registry:
     - The CLI prints:
       - `❌ Version <version> not found for package '<pkg>'`
       - `💡 Create this stable version using "opkg pack <package>" and push again.`
   - If `<version>` is found and is **stable**:
     - That version is pushed to the remote registry following the upload flow.

**Summary**

- `opkg push pkg@1.2.3`:
  - If `1.2.3` exists and is stable → push.
  - If `1.2.3` is prerelease → reject with prerelease hint.
  - If `1.2.3` does not exist → clean “version not found” message + hint to use `opkg pack`.

---

## Implicit version behavior: `opkg push <pkg>`

When no version is specified, the command **only considers stable versions**.

High-level flow:

1. Discover all versions of `<pkg>` from the local registry.
2. Compute the latest **stable** version.
3. If no stable versions exist:
   - Inform the user and exit **gracefully** (non-error).
4. If a stable version exists:
   - Prompt the user to confirm pushing that version.

**Details**

- If no stable versions are found:
  - The CLI prints:
    - `❌ No stable versions found for package '<pkg>'`
    - `💡 Stable versions can be created using "opkg pack <package>".`
  - The command exits with a **success** result (no global error message).
- If a stable version (e.g. `1.2.3`) is found:
  - The CLI prompts:
    - `Push latest stable version '1.2.3'?` (default: yes).
  - If the user **confirms**:
    - That version is pushed.
  - If the user **declines**:
    - The operation is cancelled cleanly (no additional error noise).

**Summary**

- `opkg push pkg`:
  - If **no stable versions**: print “no stable versions” + `opkg pack` hint, exit successfully.
  - If **stable versions exist**: pick the latest stable, prompt for confirmation, and push if confirmed.

---

## Stable-only guarantees (behavioral view)

From the user’s perspective:

- **Prerelease versions are never pushed.**
- Any attempt to push a prerelease:
  - Fails fast with a clear message.
  - Explains that only `x.y.z` style stable versions are allowed.
  - Suggests using `opkg pack <package>` to create a stable version.
- The previous behavior of auto-converting prereleases to stable on `push` is removed:
  - `opkg push` no longer creates or modifies versions.
  - Stable creation and promotion is done via `opkg pack`.

---

## UX examples

### Example 1: No stable versions yet

```bash
opkg push test
```

Output:
- User may be prompted to scope the package.
- Then:
  - `❌ No stable versions found for package '@user/test'`
  - `💡 Stable versions can be created using "opkg pack <package>".`
  - Command exits successfully (no trailing plain `No stable versions found` line).

---

### Example 2: Implicit push with existing stables

```bash
opkg push @user/test
```

Assume local versions: `1.0.0`, `1.1.0-dev.abc`, `1.2.0`.

Behavior:
- Finds latest stable = `1.2.0`.
- Prompts:
  - `Push latest stable version '1.2.0'?`
- On confirmation:
  - Proceeds to tarball creation and upload of `1.2.0`.

---

### Example 3: Explicit prerelease

```bash
opkg push @user/test@1.2.0-dev.abc
```

Behavior:
- Immediately rejects:
  - `❌ Prerelease versions cannot be pushed: 1.2.0-dev.abc`
  - `Only stable versions (x.y.z) can be pushed to the remote registry.`
  - `💡 Create a stable version using "opkg pack <package>".`

---

### Example 4: Explicit missing version

```bash
opkg push @user/test@2.0.0
```

Behavior:
- If `2.0.0` is not present locally:
  - `❌ Version 2.0.0 not found for package '@user/test'`
  - `💡 Create this stable version using "opkg pack <package>" and push again.`



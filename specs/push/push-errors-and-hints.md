## Push errors and hints

### Overview

This document describes how `opkg push` reports errors and guides the user with hints.
It covers both **API / network** errors and **local** errors such as missing packages, missing versions, and no stable versions.

---

## API / network errors

The following behavior is preserved from the broader CLI error-handling design, with hints tailored for `push`.

### 409 Conflict – version already exists

- Condition:
  - The remote registry responds that the version being pushed already exists.
- Behavior:
  - The CLI prints a message including:
    - `Version <attemptedVersion> already exists for package '<pkg>'`.
  - Hints:
    - `Increment version with command "opkg pack <package>"`
    - `Update version with command "opkg pack <package>@<version>"`
    - Or specify another explicit `<package>@<version>`.

### 401 / 403 – authentication or access errors

- 401 **Authentication failed**:
  - The CLI prints:
    - `❌ Authentication failed: <message>`
  - Also calls `showApiKeySignupMessage` and prints:
    - Hints for `opkg configure` and profiles.
- 403 **Access denied**:
  - The CLI prints:
    - `❌ Access denied: <message>`
  - Also shows `showApiKeySignupMessage` + `opkg configure` hints.

### 422 – validation errors

- Condition:
  - The remote registry rejects the uploaded package as invalid.
- Behavior:
  - The CLI prints:
    - `❌ Package validation failed: <message>`
  - If the response includes details:
    - Prints a `Validation errors:` header.
    - Lists each error detail on its own bullet line.

### Timeouts

- If the upload fails due to a timeout (or a timeout-like error message):
  - The CLI prints guidance such as:
    - Retry the push (it may have succeeded).
    - Check internet connectivity.
    - Increase the timeout via `OPENPACKAGEAPI_TIMEOUT`.

---

## Local errors and informational exits

### Package not found in local registry

- Condition:
  - `packageManager.packageExists(<pkg>)` returns `false`.
- Behavior:
  - The CLI prints:
    - `❌ Package '<pkg>' not found in local registry`
  - The command returns an error result:
    - `error: "Package not found"`.

### Explicit version not found

- Condition:
  - User runs `opkg push <pkg>@<version>`, and the local registry has no such version.
- Behavior:
  - The CLI prints:
    - `❌ Version <version> not found for package '<pkg>'`
    - `💡 Create this stable version using "opkg pack <package>" and push again.`
  - The command returns an error result:
    - `error: "Version not found"`.

### Explicit prerelease version

- Condition:
  - User runs `opkg push <pkg>@<version>`, where `<version>` is a prerelease.
- Behavior:
  - The CLI prints:
    - `❌ Prerelease versions cannot be pushed: <version>`
    - `Only stable versions (x.y.z) can be pushed to the remote registry.`
    - `💡 Create a stable version using "opkg pack <package>".`
  - The command returns an error result:
    - `error: "Only stable versions can be pushed"`.

### No stable versions (implicit push)

- Condition:
  - User runs `opkg push <pkg>` without specifying a version.
  - No **stable** versions of `<pkg>` exist in the local registry.
- Behavior:
  - The CLI prints:
    - `❌ No stable versions found for package '<pkg>'`
    - `💡 Stable versions can be created using "opkg pack <package>".`
  - The command returns a **success** result (no error string), so the global error handler:
    - Does **not** print an additional plain `No stable versions found` line.
  - This is treated as an informational exit: the user simply needs to create a stable version first.

---

## Cancellation behavior

### UserCancellationError

- When the user is prompted to confirm pushing a stable version and chooses “no”:
  - A `UserCancellationError` is thrown.
  - The global `withErrorHandling` wrapper:
    - Detects this specific error type.
    - Exits the process with code 0.
    - Does not print an additional error line.

This ensures that user-driven cancellations are quiet and do not appear as failures.



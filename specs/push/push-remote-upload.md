## Push remote upload flow

### Overview

Once `opkg push` has:
- Validated authentication,
- Resolved scoping, and
- Selected a stable `versionToPush`,

it performs a series of steps to package and upload the release to the remote registry.
This document describes that upload pipeline and the expected user-facing output.

---

## Upload pipeline

Assuming a valid stable package `pkg` and `versionToPush` have been selected:

1. **HTTP authentication & client**
   - `authManager.validateAuth` has already been called earlier in the command.
   - `createHttpClient` is used to construct an HTTP client configured for the current profile and registry URL.

2. **User-facing summary**
   - Before the upload, the CLI prints:
     - Package name.
     - Version.
     - Profile in use.
   - Example:
     - `✓ Pushing package '@user/test' to remote registry...`
     - `✓ Version: 1.2.3`
     - `✓ Profile: default`

3. **Validation summary**
   - The CLI prints a quick summary of the package contents:
     - Name.
     - Version.
     - Description (or `(no description)`).
     - File count.
   - This is a **logical validation** summary; detailed schema validation happens on the server side.

4. **Tarball creation**

   - `createTarballFromPackage(pkg)` builds a tarball from the package files.
   - The CLI prints:
     - `✓ Creating tarball...`
     - `✓ Created tarball (<file-count> files, <formatted-size>)`
   - The tarball metadata includes:
     - Size.
     - Checksum.

5. **Form-data preparation**

   - `createFormDataForUpload(packageName, versionToPush, tarballInfo)` builds the multipart/form-data payload.
   - This payload includes the tarball and relevant metadata required by the `/packages/push` endpoint.

6. **Upload to registry**

   - A `Spinner` displays:
     - `Uploading to registry...`
   - The client performs:
     - `POST /packages/push` with the prepared form-data.
   - On success:
     - The spinner stops.

7. **Success summary**

   - The CLI prints:
     - `✓ Push successful`
     - A section labeled `✓ Package Details:`
     - Fields such as:
       - Package name.
       - Pushed version.
       - Size (from tarball).
       - Keywords (if present).
       - Privacy flag (e.g. Private: Yes/No).
       - Creation timestamp from the server.

---

## Invariants and expectations

- The upload is only attempted after:
  - A stable version has been selected.
  - All local checks (existence, scoping) have passed.
  - Authentication has been validated.
- If the upload fails:
  - Errors are surfaced according to the rules in `push-errors-and-hints.md`.
  - The tarball creation and client setup steps are not repeated unless the user re-runs the command.



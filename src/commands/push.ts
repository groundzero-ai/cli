import { Command } from 'commander';
import { join } from 'path';
import { PushOptions, CommandResult } from '../types/index.js';
import { PushPackageResponse } from '../types/api.js';
import { packageManager } from '../core/package.js';
import { ensureRegistryDirectories, listPackageVersions } from '../core/directory.js';
import { authManager } from '../core/auth.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, PackageNotFoundError } from '../utils/errors.js';
import { createHttpClient } from '../utils/http-client.js';
import { createTarballFromPackage, createFormDataForUpload } from '../utils/tarball.js';
import * as semver from 'semver';
import { parsePackageInput } from '../utils/package-name.js';
import { promptConfirmation } from '../utils/prompts.js';
import { formatFileSize } from '../utils/formatters.js';
import { Spinner } from '../utils/spinner.js';
import { showApiKeySignupMessage } from '../utils/messages.js';
import { getLatestStableVersion } from '../utils/package-versioning.js';
import { resolveScopedNameForPushWithUserScope, isScopedName } from '../core/scoping/package-scoping.js';
import { renameRegistryPackage } from '../core/registry/registry-rename.js';
import { getLocalPackageDir } from '../utils/paths.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { exists } from '../utils/fs.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { applyWorkspacePackageRename } from '../core/save/workspace-rename.js';
import { type PackageContext } from '../core/package-context.js';
import { getCurrentUsername } from '../core/api-keys.js';

async function tryRenameWorkspacePackage(
  cwd: string,
  oldName: string,
  newName: string
): Promise<void> {
  try {
    const packageDir = getLocalPackageDir(cwd, oldName);
    const packageYmlPath = join(packageDir, FILE_PATTERNS.PACKAGE_YML);

    if (!(await exists(packageYmlPath))) {
      return;
    }

    const config = await parsePackageYml(packageYmlPath);
    
    // Construct full PackageContext for nested package
    const packageContext: PackageContext = {
      name: config.name,
      version: config.version,
      config,
      packageYmlPath,
      packageFilesDir: packageDir,
      location: 'nested',
      isCwdPackage: false,
      isNew: false
    };

    await applyWorkspacePackageRename(cwd, packageContext, newName);
    console.log(`✓ Updated workspace package name: ${oldName} → ${newName}`);
  } catch (error) {
    logger.debug('Workspace package rename skipped', {
      oldName,
      newName,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function pushPackageCommand(
  packageInput: string,
  options: PushOptions
): Promise<CommandResult> {
  logger.info(`Pushing package '${packageInput}' to remote registry`, { options });
  const cwd = process.cwd();
  const { name: parsedName, version: parsedVersion } = parsePackageInput(packageInput);
  let packageNameToPush = parsedName;
  let attemptedVersion: string | undefined;

  try {
    // Ensure registry directories exist
    await ensureRegistryDirectories();

    // Verify package exists locally
    const packageExists = await packageManager.packageExists(packageNameToPush);
    if (!packageExists) {
      console.error(`❌ Package '${packageNameToPush}' not found in local registry`);
      return { success: false, error: 'Package not found' };
    }

    const authOptions = {
      profile: options.profile,
      apiKey: options.apiKey
    };

    // Authentication required for push operation (also needed for scope resolution)
    await authManager.validateAuth(authOptions);

    if (!isScopedName(packageNameToPush)) {
      const username = await getCurrentUsername(authOptions);
      const scopedName = await resolveScopedNameForPushWithUserScope(
        packageNameToPush,
        username,
        options.profile
      );
      await renameRegistryPackage(packageNameToPush, scopedName);
      await tryRenameWorkspacePackage(cwd, packageNameToPush, scopedName);
      packageNameToPush = scopedName;
    }

    // Determine which version to push
    let pkg;
    let versionToPush: string;

    if (parsedVersion) {
      // Explicit version flow
      if (semver.prerelease(parsedVersion)) {
        console.error(`❌ Prerelease versions cannot be pushed: ${parsedVersion}`);
        console.log('Only stable versions (x.y.z) can be pushed to the remote registry.');
        console.log('💡 Create a stable version using "opkg pack <package>".');
        return { success: false, error: 'Only stable versions can be pushed' };
      }

      try {
        pkg = await packageManager.loadPackage(packageNameToPush, parsedVersion);
      } catch (error) {
        if (error instanceof PackageNotFoundError) {
          console.error(`❌ Version ${parsedVersion} not found for package '${packageNameToPush}'`);
          console.log('💡 Create this stable version using "opkg pack <package>" and push again.');
          return { success: false, error: 'Version not found' };
        }
        throw error;
      }

      versionToPush = pkg.metadata.version;
    } else {
      // Implicit version flow - use latest stable only
      const allVersions = await listPackageVersions(packageNameToPush);
      const latestStable = getLatestStableVersion(allVersions);

      if (!latestStable) {
        console.error(`❌ No stable versions found for package '${packageNameToPush}'`);
        console.log('💡 Stable versions can be created using "opkg pack <package>".');
        // Treat as a graceful, non-error exit to avoid duplicate plain error output
        return { success: true };
      }

      const proceed = await promptConfirmation(
        `Push latest stable version '${latestStable}'?`,
        true
      );
      if (!proceed) {
        throw new UserCancellationError('User declined pushing the stable version');
      }

      pkg = await packageManager.loadPackage(packageNameToPush, latestStable);
      versionToPush = pkg.metadata.version;
    }

    attemptedVersion = versionToPush;

    if (semver.prerelease(versionToPush)) {
      console.error(`❌ Prerelease versions cannot be pushed: ${versionToPush}`);
      console.log('Only stable versions (x.y.z) can be pushed to the remote registry.');
      console.log('💡 Create a stable version using "opkg pack <package>".');
      return { success: false, error: 'Only stable versions can be pushed' };
    }
    
    // Authenticate and create HTTP client
    const httpClient = await createHttpClient(authOptions);
    
    const registryUrl = authManager.getRegistryUrl();
    const profile = authManager.getCurrentProfile(authOptions);
    
    console.log(`✓ Pushing package '${packageNameToPush}' to remote registry...`);
    console.log(`✓ Version: ${versionToPush}`);
    console.log(`✓ Profile: ${profile}`);
    console.log('');
    
    // Step 1: Validate package completeness
    console.log('✓ Package validation complete');
    console.log(`  • Name: ${pkg.metadata.name}`);
    console.log(`  • Version: ${versionToPush}`);
    console.log(`  • Description: ${pkg.metadata.description || '(no description)'}`);
    console.log(`  • Files: ${pkg.files.length}`);
    
    // Step 2: Create tarball
    console.log('✓ Creating tarball...');
    const tarballInfo = await createTarballFromPackage(pkg);
    console.log(`✓ Created tarball (${pkg.files.length} files, ${formatFileSize(tarballInfo.size)})`);
    
    // Step 3: Prepare upload data
    const formData = createFormDataForUpload(packageNameToPush, versionToPush, tarballInfo);
    
    // Step 4: Upload to registry
    const uploadSpinner = new Spinner('Uploading to registry...');
    uploadSpinner.start();
    
    let response: PushPackageResponse;
    try {
      response = await httpClient.uploadFormData<PushPackageResponse>(
        '/packages/push',
        formData
      );
      uploadSpinner.stop();
    } catch (error) {
      uploadSpinner.stop();
      throw error;
    }
    
    // Step 5: Success!
    console.log('✓ Push successful');
    console.log('');
    console.log('✓ Package Details:');
    console.log(`  • Name: ${response.package.name}`);
    console.log(`  • Version: ${response.version.version}`);
    console.log(`  • Size: ${formatFileSize(tarballInfo.size)}`);
    const keywords = Array.isArray(response.package.keywords) ? response.package.keywords : [];
    if (keywords.length > 0) {
      console.log(`  • Keywords: ${keywords.join(', ')}`);
    }
    console.log(`  • Private: ${response.package.isPrivate ? 'Yes' : 'No'}`);
    console.log(`  • Created: ${new Date(response.version.createdAt).toLocaleString()}`);
    
    return {
      success: true,
      data: {
        packageName: response.package.name,
        version: response.version.version,
        size: tarballInfo.size,
        checksum: tarballInfo.checksum,
        registry: registryUrl,
        profile,
        message: response.message
      }
    };
    
  } catch (error) {
    logger.debug('Push command failed', { error, packageName: packageNameToPush });
    
    // Handle specific error cases
    if (error instanceof Error) {
      const apiError = (error as any).apiError;
      
      if (apiError?.statusCode === 409) {
        console.error(`❌ Version ${attemptedVersion || 'latest'} already exists for package '${packageNameToPush}'`);
        console.log('💡 Try one of these options:');
        console.log('  • Increment version with command "opkg pack <package>"');
        console.log('  • Update version with command "opkg pack <package>@<version>"');
        console.log('  • Specify a version explicitly using <package>@<version>');
        return { success: false, error: 'Version already exists' };
      }
      
      if (apiError?.statusCode === 401) {
        console.error(`❌ Authentication failed: ${error.message}`);
        showApiKeySignupMessage();
        console.log('💡 To configure authentication:');
        console.log('  opkg configure');
        console.log('  opkg configure --profile <name>');
        return { success: false, error: 'Authentication failed' };
      }

      if (apiError?.statusCode === 403) {
        console.error(`❌ Access denied: ${error.message}`);
        showApiKeySignupMessage();
        console.log('💡 To configure authentication:');
        console.log('  opkg configure');
        console.log('  opkg configure --profile <name>');
        return { success: false, error: 'Access denied' };
      }
      
      if (apiError?.statusCode === 422) {
        console.error(`❌ Package validation failed: ${error.message}`);
        if (apiError.details) {
          console.log('Validation errors:');
          if (Array.isArray(apiError.details)) {
            apiError.details.forEach((detail: any) => {
              console.log(`  • ${detail.message || detail}`);
            });
          } else {
            console.log(`  • ${apiError.details}`);
          }
        }
        return { success: false, error: 'Validation failed' };
      }
      
      // Generic error handling (do not print here; global handler will print once)
      
      if (error.message.includes('timeout')) {
        console.log('💡 The upload may have timed out. You can:');
        console.log('  • Try again (the upload may have succeeded)');
        console.log('  • Check your internet connection');
        console.log('  • Set OPENPACKAGEAPI_TIMEOUT environment variable for longer timeout');
      }
      
      return { success: false, error: error.message };
    }
    
    return { success: false, error: 'Unknown error occurred' };
  }
}

/**
 * Setup the push command
 */
export function setupPushCommand(program: Command): void {
  program
    .command('push')
    .description('Push a package to remote registry. Supports package@version syntax.')
    .argument('<package-name>', 'name of the package to push. Supports package@version syntax.')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (packageName: string, options: PushOptions) => {
      const result = await pushPackageCommand(packageName, options);
      if (!result.success) {
        throw new Error(result.error || 'Push operation failed');
      }
    }));
}

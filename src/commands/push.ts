import { Command } from 'commander';
import { join } from 'path';
import { PushOptions, CommandResult } from '../types/index.js';
import { PushPackageResponse } from '../types/api.js';
import { packageManager } from '../core/package.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { authManager } from '../core/auth.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { createHttpClient } from '../utils/http-client.js';
import { createTarballFromPackage, createFormDataForUpload } from '../utils/tarball.js';
import * as semver from 'semver';
import { parsePackageInput } from '../utils/package-name.js';
import { promptConfirmation } from '../utils/prompts.js';
import { UserCancellationError } from '../utils/errors.js';
import { formatFileSize } from '../utils/formatters.js';
import { Spinner } from '../utils/spinner.js';
import { 
  computeStableVersion, 
  transformPackageFilesForVersionChange,
  packageVersionExists 
} from '../utils/package-versioning.js';
import { showApiKeySignupMessage } from '../utils/messages.js';
import { resolveScopedNameForPush, isScopedName } from '../core/scoping/package-scoping.js';
import { renameRegistryPackage } from '../core/registry/registry-rename.js';
import { getLocalPackageDir } from '../utils/paths.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { exists } from '../utils/fs.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { applyWorkspacePackageRename } from '../core/save/workspace-rename.js';
import type { PackageYmlInfo } from '../core/save/package-yml-generator.js';

/**
 * Push package command implementation
 */
async function createStablePackageVersion(pkg: any, stableVersion: string): Promise<any> {
  // Abort if target stable version already exists
  if (await packageVersionExists(pkg.metadata.name, stableVersion)) {
    throw new Error(`Stable version already exists: ${pkg.metadata.name}@${stableVersion}`);
  }

  const transformedFiles = transformPackageFilesForVersionChange(
    pkg.files,
    stableVersion,
    pkg.metadata.name
  );

  const newPackage = {
    metadata: {
      ...pkg.metadata,
      version: stableVersion
    },
    files: transformedFiles
  };

  await packageManager.savePackage(newPackage);
  return newPackage;
}

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
    const packageInfo: PackageYmlInfo = {
      fullPath: packageYmlPath,
      config,
      isNewPackage: false,
      isRootPackage: false
    };

    await applyWorkspacePackageRename(cwd, packageInfo, newName);
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

  showApiKeySignupMessage();

  try {
    // Ensure registry directories exist
    await ensureRegistryDirectories();

    // Verify package exists locally
    const packageExists = await packageManager.packageExists(packageNameToPush);
    if (!packageExists) {
      console.error(`❌ Package '${packageNameToPush}' not found in local registry`);
      return { success: false, error: 'Package not found' };
    }

    if (!isScopedName(packageNameToPush)) {
      const scopedName = await resolveScopedNameForPush(packageNameToPush, options.profile);
      await renameRegistryPackage(packageNameToPush, scopedName);
      await tryRenameWorkspacePackage(cwd, packageNameToPush, scopedName);
      packageNameToPush = scopedName;
    }

    // Load package and determine version
    let pkg = await packageManager.loadPackage(packageNameToPush, parsedVersion);
    let versionToPush = parsedVersion || pkg.metadata.version;
    attemptedVersion = versionToPush;

    // Reject or handle prerelease versions
    if (semver.prerelease(versionToPush)) {
      if (parsedVersion) {
        // Explicit prerelease remains an error
        console.error(`❌ Prerelease versions cannot be pushed: ${versionToPush}`);
        console.log('');
        console.log('Only stable versions (x.y.z) can be pushed to the remote registry.');
        console.log('💡 Please create a stable package using the command "opkg save <package> stable".');
        return { success: false, error: 'Only stable versions can be pushed' };
      } else {
        // Latest is prerelease and no version was specified -> prompt to convert
        const proceed = await promptConfirmation(
          `Latest version '${versionToPush}' is a prerelease. Convert to stable and push?`,
          false
        );
        if (!proceed) {
          throw new UserCancellationError('User declined prerelease to stable conversion');
        }

        const stableVersion = computeStableVersion(versionToPush);
        console.log(`Converting to stable '${stableVersion}' and pushing...`);
        pkg = await createStablePackageVersion(pkg, stableVersion);
        versionToPush = stableVersion;
        attemptedVersion = versionToPush;
      }
    }
    
    // Authenticate and create HTTP client
    const authOptions = {
      profile: options.profile,
      apiKey: options.apiKey
    };

    // Authentication required for push operation
    await authManager.validateAuth(authOptions);
    
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
        console.log('');
        console.log('💡 Try one of these options:');
        console.log('  • Increment version with command "opkg save <package> stable"');
        console.log('  • Update version with command "opkg save <package>@<version>"');
        console.log('  • Specify a version explicitly using <package>@<version>');
        return { success: false, error: 'Version already exists' };
      }
      
      if (apiError?.statusCode === 401) {
        console.error(`❌ Authentication failed: ${error.message}`);
        console.log('');
        console.log('💡 To configure authentication:');
        console.log('  opkg configure');
        console.log('  opkg configure --profile <name>');
        return { success: false, error: 'Authentication failed' };
      }

      if (apiError?.statusCode === 403) {
        console.error(`❌ Access denied: ${error.message}`);
        console.log('');
        console.log('💡 To configure authentication:');
        console.log('  opkg configure');
        console.log('  opkg configure --profile <name>');
        return { success: false, error: 'Access denied' };
      }
      
      if (apiError?.statusCode === 422) {
        console.error(`❌ Package validation failed: ${error.message}`);
        if (apiError.details) {
          console.log('');
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
        console.log('');
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

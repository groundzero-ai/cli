import { Command } from 'commander';
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
import { showBetaRegistryMessage } from '../utils/messages.js';
import { promptConfirmation } from '../utils/prompts.js';
import { UserCancellationError } from '../utils/errors.js';
import { formatFileSize } from '../utils/formatters.js';
import { Spinner } from '../utils/spinner.js';
import { 
  computeStableVersion, 
  transformPackageFilesForVersionChange,
  formulaVersionExists 
} from '../utils/package-versioning.js';

/**
 * Push formula command implementation
 */
async function createStablePackageVersion(pkg: any, stableVersion: string): Promise<any> {
  // Abort if target stable version already exists
  if (await formulaVersionExists(pkg.metadata.name, stableVersion)) {
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

async function pushPackageCommand(
  formulaInput: string,
  options: PushOptions
): Promise<CommandResult> {
  logger.info(`Pushing formula '${formulaInput}' to remote registry`, { options });
  const { name: parsedName, version: parsedVersion } = parsePackageInput(formulaInput);
  let attemptedVersion: string | undefined;

  showBetaRegistryMessage();
  
  try {
    // Ensure registry directories exist
    await ensureRegistryDirectories();
    
    // Verify formula exists locally
    const exists = await packageManager.packageExists(parsedName);
    if (!exists) {
      console.error(`❌ Package '${parsedName}' not found in local registry`);
      return { success: false, error: 'Package not found' };
    }
    
    // Load formula and determine version
    let formula = await packageManager.loadPackage(parsedName, parsedVersion);
    let versionToPush = parsedVersion || formula.metadata.version;
    attemptedVersion = versionToPush;

    // Reject or handle prerelease versions
    if (semver.prerelease(versionToPush)) {
      if (parsedVersion) {
        // Explicit prerelease remains an error
        console.error(`❌ Prerelease versions cannot be pushed: ${versionToPush}`);
        console.log('');
        console.log('Only stable versions (x.y.z) can be pushed to the remote registry.');
        console.log('💡 Please create a stable formula using the command "opn save <formula> stable".');
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
        formula = await createStablePackageVersion(formula, stableVersion);
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
    
    console.log(`✓ Pushing formula '${parsedName}' to remote registry...`);
    console.log(`✓ Version: ${versionToPush}`);
    console.log(`✓ Profile: ${profile}`);
    console.log('');
    
    // Step 1: Validate formula completeness
    console.log('✓ Package validation complete');
    console.log(`  • Name: ${formula.metadata.name}`);
    console.log(`  • Version: ${versionToPush}`);
    console.log(`  • Description: ${formula.metadata.description || '(no description)'}`);
    console.log(`  • Files: ${formula.files.length}`);
    
    // Step 2: Create tarball
    console.log('✓ Creating tarball...');
    const tarballInfo = await createTarballFromPackage(formula);
    console.log(`✓ Created tarball (${formula.files.length} files, ${formatFileSize(tarballInfo.size)})`);
    
    // Step 3: Prepare upload data
    const formData = createFormDataForUpload(parsedName, versionToPush, tarballInfo);
    
    // Step 4: Upload to registry
    const uploadSpinner = new Spinner('Uploading to registry...');
    uploadSpinner.start();
    
    let response: PushPackageResponse;
    try {
      response = await httpClient.uploadFormData<PushPackageResponse>(
        '/formulas/push',
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
        formulaName: response.package.name,
        version: response.version.version,
        size: tarballInfo.size,
        checksum: tarballInfo.checksum,
        registry: registryUrl,
        profile,
        message: response.message
      }
    };
    
  } catch (error) {
    logger.debug('Push command failed', { error, formulaName: parsedName });
    
    // Handle specific error cases
    if (error instanceof Error) {
      const apiError = (error as any).apiError;
      
      if (apiError?.statusCode === 409) {
        console.error(`❌ Version ${attemptedVersion || 'latest'} already exists for formula '${parsedName}'`);
        console.log('');
        console.log('💡 Try one of these options:');
        console.log('  • Increment version with command "opn save <formula> stable"');
        console.log('  • Update version with command "opn save <formula>@<version>"');
        console.log('  • Specify a version explicitly using <formula>@<version>');
        return { success: false, error: 'Version already exists' };
      }
      
      if (apiError?.statusCode === 401) {
        console.error(`❌ Authentication failed: ${error.message}`);
        console.log('');
        console.log('💡 To configure authentication:');
        console.log('  opn configure');
        console.log('  opn configure --profile <name>');
        return { success: false, error: 'Authentication failed' };
      }

      if (apiError?.statusCode === 403) {
        console.error(`❌ Access denied: ${error.message}`);
        console.log('');
        console.log('💡 To configure authentication:');
        console.log('  opn configure');
        console.log('  opn configure --profile <name>');
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
    .description('Push a formula to remote registry. Supports formula@version syntax.')
    .argument('<package-name>', 'name of the formula to push. Supports formula@version syntax.')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (formulaName: string, options: PushOptions) => {
      const result = await pushPackageCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Push operation failed');
      }
    }));
}

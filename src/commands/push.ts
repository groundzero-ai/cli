import { Command } from 'commander';
import { PushOptions, CommandResult } from '../types/index.js';
import { PushFormulaResponse } from '../types/api.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { authManager } from '../core/auth.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { createHttpClient } from '../utils/http-client.js';
import { createTarballFromFormula, createFormDataForUpload } from '../utils/tarball.js';
import * as semver from 'semver';
import { parseFormulaInput } from '../utils/formula-name.js';
import { showBetaRegistryMessage } from '../utils/messages.js';
import { promptConfirmation } from '../utils/prompts.js';
import { UserCancellationError } from '../utils/errors.js';
import { formatFileSize } from '../utils/formatters.js';
import { Spinner } from '../utils/spinner.js';
import { 
  computeStableVersion, 
  transformFormulaFilesForVersionChange,
  formulaVersionExists 
} from '../utils/formula-versioning.js';

/**
 * Push formula command implementation
 */
async function createStableFormulaVersion(formula: any, stableVersion: string): Promise<any> {
  // Abort if target stable version already exists
  if (await formulaVersionExists(formula.metadata.name, stableVersion)) {
    throw new Error(`Stable version already exists: ${formula.metadata.name}@${stableVersion}`);
  }

  const transformedFiles = transformFormulaFilesForVersionChange(
    formula.files,
    stableVersion,
    formula.metadata.name
  );

  const newFormula = {
    metadata: {
      ...formula.metadata,
      version: stableVersion
    },
    files: transformedFiles
  };

  await formulaManager.saveFormula(newFormula);
  return newFormula;
}

async function pushFormulaCommand(
  formulaInput: string,
  options: PushOptions
): Promise<CommandResult> {
  logger.info(`Pushing formula '${formulaInput}' to remote registry`, { options });
  const { name: parsedName, version: parsedVersion } = parseFormulaInput(formulaInput);
  let attemptedVersion: string | undefined;

  showBetaRegistryMessage();
  
  try {
    // Ensure registry directories exist
    await ensureRegistryDirectories();
    
    // Verify formula exists locally
    const exists = await formulaManager.formulaExists(parsedName);
    if (!exists) {
      console.error(`❌ Formula '${parsedName}' not found in local registry`);
      return { success: false, error: 'Formula not found' };
    }
    
    // Load formula and determine version
    let formula = await formulaManager.loadFormula(parsedName, parsedVersion);
    let versionToPush = parsedVersion || formula.metadata.version;
    attemptedVersion = versionToPush;

    // Reject or handle prerelease versions
    if (semver.prerelease(versionToPush)) {
      if (parsedVersion) {
        // Explicit prerelease remains an error
        console.error(`❌ Prerelease versions cannot be pushed: ${versionToPush}`);
        console.log('');
        console.log('Only stable versions (x.y.z) can be pushed to the remote registry.');
        console.log('💡 Please create a stable formula using the command "g0 save <formula> stable".');
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
        formula = await createStableFormulaVersion(formula, stableVersion);
        versionToPush = stableVersion;
        attemptedVersion = versionToPush;
      }
    }
    
    // Authenticate and create HTTP client
    const httpClient = await createHttpClient({
      profile: options.profile,
      apiKey: options.apiKey
    });
    
    const registryUrl = authManager.getRegistryUrl();
    const profile = authManager.getCurrentProfile({ profile: options.profile });
    
    console.log(`✓ Pushing formula '${parsedName}' to remote registry...`);
    console.log(`✓ Version: ${versionToPush}`);
    console.log(`✓ Profile: ${profile}`);
    console.log('');
    
    // Step 1: Validate formula completeness
    console.log('✓ Formula validation complete');
    console.log(`  • Name: ${formula.metadata.name}`);
    console.log(`  • Version: ${versionToPush}`);
    console.log(`  • Description: ${formula.metadata.description || '(no description)'}`);
    console.log(`  • Files: ${formula.files.length}`);
    
    // Step 2: Create tarball
    console.log('✓ Creating tarball...');
    const tarballInfo = await createTarballFromFormula(formula);
    console.log(`✓ Created tarball (${formula.files.length} files, ${formatFileSize(tarballInfo.size)})`);
    
    // Step 3: Prepare upload data
    const formData = createFormDataForUpload(parsedName, versionToPush, tarballInfo);
    
    // Step 4: Upload to registry
    const uploadSpinner = new Spinner('Uploading to registry...');
    uploadSpinner.start();
    
    let response: PushFormulaResponse;
    try {
      response = await httpClient.uploadFormData<PushFormulaResponse>(
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
    console.log('✓ Formula Details:');
    console.log(`  • Name: ${response.formula.name}`);
    console.log(`  • Version: ${response.version.version}`);
    console.log(`  • Size: ${formatFileSize(tarballInfo.size)}`);
    console.log(`  • Formula ID: ${response.formula._id}`);
    console.log(`  • Version ID: ${response.version._id}`);
    const keywords = Array.isArray(response.formula.keywords) ? response.formula.keywords : [];
    if (keywords.length > 0) {
      console.log(`  • Keywords: ${keywords.join(', ')}`);
    }
    console.log(`  • Private: ${response.formula.isPrivate ? 'Yes' : 'No'}`);
    console.log(`  • Created: ${new Date(response.version.createdAt).toLocaleString()}`);
    
    return {
      success: true,
      data: {
        formulaName: response.formula.name,
        version: response.version.version,
        formulaId: response.formula._id,
        versionId: response.version._id,
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
        console.log('  • Increment the version in your formula.yml');
        console.log('  • Specify a version explicitly using formula@<version>');
        console.log('  • Contact the registry administrator if you need to replace this version');
        return { success: false, error: 'Version already exists' };
      }
      
      if (apiError?.statusCode === 401) {
        console.error(`❌ Authentication failed: ${error.message}`);
        console.log('');
        console.log('💡 To configure authentication:');
        console.log('  g0 configure');
        console.log('  g0 configure --profile <name>');
        return { success: false, error: 'Authentication failed' };
      }

      if (apiError?.statusCode === 403) {
        console.error(`❌ Access denied: ${error.message}`);
        console.log('');
        console.log('💡 To configure authentication:');
        console.log('  g0 configure');
        console.log('  g0 configure --profile <name>');
        return { success: false, error: 'Access denied' };
      }
      
      if (apiError?.statusCode === 422) {
        console.error(`❌ Formula validation failed: ${error.message}`);
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
        console.log('  • Set G0_API_TIMEOUT environment variable for longer timeout');
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
    .argument('<formula-name>', 'name of the formula to push. Supports formula@version syntax.')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (formulaName: string, options: PushOptions) => {
      const result = await pushFormulaCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Push operation failed');
      }
    }));
}

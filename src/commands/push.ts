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

/**
 * Push formula command implementation
 */
async function pushFormulaCommand(
  formulaName: string,
  options: PushOptions
): Promise<CommandResult> {
  logger.info(`Pushing formula '${formulaName}' to remote registry`, { options });
  
  try {
    // Ensure registry directories exist
    await ensureRegistryDirectories();
    
    // Verify formula exists locally
    const exists = await formulaManager.formulaExists(formulaName);
    if (!exists) {
      console.error(`❌ Formula '${formulaName}' not found in local registry`);
      return { success: false, error: 'Formula not found' };
    }
    
    // Load formula and determine version
    const formula = await formulaManager.loadFormula(formulaName, options.version);
    const versionToPush = options.version || formula.metadata.version;
    
    // Authenticate and create HTTP client
    const httpClient = await createHttpClient({
      profile: options.profile,
      apiKey: options.apiKey
    });
    
    const registryUrl = authManager.getRegistryUrl();
    const profile = authManager.getCurrentProfile({ profile: options.profile });
    
    console.log(`📤 Pushing formula '${formulaName}' to remote registry...`);
    console.log(`📦 Version: ${versionToPush}`);
    console.log(`🌐 Registry: ${registryUrl}`);
    console.log(`🔑 Profile: ${profile}`);
    console.log('');
    
    // Step 1: Validate formula completeness
    console.log('✓ Formula validation complete');
    console.log(`  • Name: ${formula.metadata.name}`);
    console.log(`  • Version: ${versionToPush}`);
    console.log(`  • Description: ${formula.metadata.description || '(no description)'}`);
    console.log(`  • Files: ${formula.files.length}`);
    
    // Step 2: Create tarball
    console.log('📦 Creating tarball...');
    const tarballInfo = await createTarballFromFormula(formula);
    const sizeInMB = (tarballInfo.size / (1024 * 1024)).toFixed(2);
    console.log(`✓ Created tarball (${formula.files.length} files, ${sizeInMB}MB)`);
    
    // Step 3: Prepare upload data
    const formData = createFormDataForUpload(formulaName, versionToPush, tarballInfo);
    
    // Step 4: Upload to registry
    console.log('🚀 Uploading to registry...');
    const response = await httpClient.uploadFormData<PushFormulaResponse>(
      '/formulas/push',
      formData
    );
    
    // Step 5: Success!
    console.log('✅ Formula pushed successfully!');
    console.log('');
    console.log('📊 Formula Details:');
    console.log(`  • Name: ${response.formula.name}`);
    console.log(`  • Version: ${response.version.version}`);
    console.log(`  • Size: ${sizeInMB}MB`);
    console.log(`  • Formula ID: ${response.formula._id}`);
    console.log(`  • Version ID: ${response.version._id}`);
    console.log(`  • Tags: ${response.formula.tags.join(', ') || 'none'}`);
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
    logger.debug('Push command failed', { error, formulaName });
    
    // Handle specific error cases
    if (error instanceof Error) {
      const apiError = (error as any).apiError;
      
      if (apiError?.statusCode === 409) {
        console.error(`❌ Version ${options.version || 'latest'} already exists for formula '${formulaName}'`);
        console.log('');
        console.log('💡 Try one of these options:');
        console.log('  • Increment the version in your formula.yml');
        console.log('  • Use --version to specify a new version');
        console.log('  • Contact the registry administrator if you need to replace this version');
        return { success: false, error: 'Version already exists' };
      }
      
      if (apiError?.statusCode === 401 || apiError?.statusCode === 403) {
        console.error(`❌ Authentication failed: ${error.message}`);
        console.log('');
        console.log('💡 To configure authentication:');
        console.log('  g0 configure');
        console.log('  g0 configure --profile <name>');
        return { success: false, error: 'Authentication failed' };
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
    .description('Push a formula to remote registry')
    .argument('<formula-name>', 'name of the formula to push')
    .option('--version <version>', 'specific version to push')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (formulaName: string, options: PushOptions) => {
      const result = await pushFormulaCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Push operation failed');
      }
    }));
}

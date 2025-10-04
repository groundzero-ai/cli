import { Command } from 'commander';
import { PullOptions, CommandResult } from '../types/index.js';
import { PullFormulaResponse } from '../types/api.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { authManager } from '../core/auth.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { createHttpClient } from '../utils/http-client.js';
import { extractFormulaFromTarball, verifyTarballIntegrity } from '../utils/tarball.js';

/**
 * Pull formula command implementation
 */
async function pullFormulaCommand(
  formulaName: string,
  options: PullOptions
): Promise<CommandResult> {
  logger.info(`Pulling formula '${formulaName}' from remote registry`, { options });
  
  try {
    // Ensure registry directories exist
    await ensureRegistryDirectories();
    
    // Authenticate and create HTTP client
    const httpClient = await createHttpClient({
      profile: options.profile,
      apiKey: options.apiKey
    });
    
    const registryUrl = authManager.getRegistryUrl();
    const profile = authManager.getCurrentProfile({ profile: options.profile });
    const versionToPull = options.version || 'latest';
    
    console.log(`📥 Pulling formula '${formulaName}' from remote registry...`);
    console.log(`📦 Version: ${versionToPull}`);
    console.log(`🔑 Profile: ${profile}`);
    console.log('');
    
    // Check if formula already exists locally
    const localExists = await formulaManager.formulaExists(formulaName);
    if (localExists && !options.version) {
      // For specific version requests, we'll allow overwrites
      // For 'latest', we should warn the user
      console.log(`⚠️  Formula '${formulaName}' already exists locally`);
      console.log('Pulling will overwrite the local version.');
      console.log('');
    }
    
    // Step 1: Query the registry for the formula
    console.log('🔍 Querying registry for formula...');
    const endpoint = `/formulas/pull/${encodeURIComponent(formulaName)}/${encodeURIComponent(versionToPull)}`;
    const response = await httpClient.get<PullFormulaResponse>(endpoint);
    
    console.log('✓ Formula found in registry');
    console.log(`  • Name: ${response.formula.name}`);
    console.log(`  • Version: ${response.version.version}`);
    console.log(`  • Description: ${response.formula.description || '(no description)'}`);
    console.log(`  • Size: ${(response.version.tarballSize / (1024 * 1024)).toFixed(2)}MB`);
    console.log(`  • Tags: ${response.formula.tags.join(', ') || 'none'}`);
    console.log(`  • Private: ${response.formula.isPrivate ? 'Yes' : 'No'}`);
    console.log(`  • Created: ${new Date(response.version.createdAt).toLocaleString()}`);
    
    // Step 2: Download the tarball
    console.log('📥 Downloading formula tarball...');
    const tarballBuffer = Buffer.from(await httpClient.downloadFile(response.downloadUrl));
    
    // Step 3: Verify tarball integrity
    console.log('🔐 Verifying tarball integrity...');
    const isValid = verifyTarballIntegrity(
      tarballBuffer,
      response.version.tarballSize
    );
    
    if (!isValid) {
      throw new Error('Tarball integrity verification failed');
    }
    
    console.log('✓ Tarball verified successfully');
    
    // Step 4: Extract formula from tarball
    console.log('📂 Extracting formula files...');
    const extracted = await extractFormulaFromTarball(tarballBuffer);
    
    // Step 5: Save to local registry
    console.log('💾 Installing to local registry...');
    
    // Create formula object for local storage
    const formula = {
      metadata: {
        name: response.formula.name,
        version: response.version.version,
        description: response.formula.description,
        created: response.version.createdAt,
        updated: response.version.updatedAt,
        files: extracted.files.map(f => f.path)
      },
      files: extracted.files
    };
    
    await formulaManager.saveFormula(formula);
    
    // Step 6: Success!
    console.log('✅ Formula pulled and installed successfully!');
    console.log('');
    console.log('📊 Installation Summary:');
    console.log(`  • Name: ${response.formula.name}`);
    console.log(`  • Version: ${response.version.version}`);
    console.log(`  • Files: ${extracted.files.length}`);
    console.log(`  • Size: ${(response.version.tarballSize / (1024 * 1024)).toFixed(2)}MB`);
    console.log(`  • Checksum: ${extracted.checksum.substring(0, 16)}...`);
    console.log('');
    console.log('🎯 Next steps:');
    console.log(`  g0 show ${response.formula.name}         # View formula details`);
    console.log(`  g0 install ${response.formula.name}     # Install formula to current project`);
    
    return {
      success: true,
      data: {
        formulaName: response.formula.name,
        version: response.version.version,
        formulaId: response.formula._id,
        versionId: response.version._id,
        files: extracted.files.length,
        size: response.version.tarballSize,
        checksum: extracted.checksum,
        registry: registryUrl,
        profile,
        isPrivate: response.formula.isPrivate,
        downloadUrl: response.downloadUrl,
        message: 'Formula pulled and installed successfully'
      }
    };
    
  } catch (error) {
    logger.debug('Pull command failed', { error, formulaName });
    
    // Handle specific error cases
    if (error instanceof Error) {
      const apiError = (error as any).apiError;
      
      if (apiError?.statusCode === 404) {
        console.error(`❌ Formula '${formulaName}' not found in registry`);
        if (options.version) {
          console.log(`Version '${options.version}' does not exist.`);
        } else {
          console.log('Formula does not exist in the registry.');
        }
        console.log('');
        console.log('💡 Try one of these options:');
        console.log('  • Check the formula name spelling');
        console.log('  • Use g0 search to find available formulas');
        console.log('  • Verify you have access to this formula if it\'s private');
        return { success: false, error: 'Formula not found' };
      }
      
      if (apiError?.statusCode === 401 || apiError?.statusCode === 403) {
        console.error(error.message);
        console.log('');
        if (apiError?.statusCode === 403) {
          console.log('💡 This may be a private formula. Ensure you have VIEWER permissions.');
        }
        console.log('💡 To configure authentication:');
        console.log('  g0 configure');
        console.log('  g0 configure --profile <name>');
        return { success: false, error: 'Access denied' };
      }
      
      if (error.message.includes('Download') || error.message.includes('timeout')) {
        // Let global handler print the message
        console.log('');
        console.log('💡 Try one of these options:');
        console.log('  • Check your internet connection');
        console.log('  • Try again (temporary network issue)');
        console.log('  • Set G0_API_TIMEOUT environment variable for longer timeout');
        return { success: false, error: 'Download failed' };
      }
      
      if (error.message.includes('integrity') || error.message.includes('checksum')) {
        console.error(`❌ Formula integrity verification failed: ${error.message}`);
        console.log('');
        console.log('💡 The downloaded formula may be corrupted. Try pulling again.');
        return { success: false, error: 'Integrity verification failed' };
      }
      
      // Generic error handling (no direct print; global handler will print once)
      return { success: false, error: error.message };
    }
    
    return { success: false, error: 'Unknown error occurred' };
  }
}

/**
 * Setup the pull command
 */
export function setupPullCommand(program: Command): void {
  program
    .command('pull')
    .description('Pull a formula from remote registry')
    .argument('<formula-name>', 'name of the formula to pull')
    .option('--version <version>', 'specific version to pull')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (formulaName: string, options: PullOptions) => {
      const result = await pullFormulaCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Pull operation failed');
      }
    }));
}

import { Command } from 'commander';
import { PullOptions, CommandResult } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import { hasFormulaVersion } from '../core/directory.js';
import { authManager } from '../core/auth.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { showBetaRegistryMessage } from '../utils/messages.js';
import { promptOverwriteConfirmation } from '../utils/prompts.js';
import { formatFileSize } from '../utils/formatters.js';
import { fetchRemoteFormulaMetadata, pullFormulaFromRemote, RemotePullFailure } from '../core/remote-pull.js';

/**
 * Pull formula command implementation
 */
async function pullFormulaCommand(
  formulaInput: string,
  options: PullOptions
): Promise<CommandResult> {
  const { name: parsedName, version: parsedVersion } = parseFormulaInput(formulaInput);
  logger.info(`Pulling formula '${parsedName}' from remote registry`, { options });

  showBetaRegistryMessage();

  try {
    const authOptions = {
      profile: options.profile,
      apiKey: options.apiKey
    };

    const metadataResult = await fetchRemoteFormulaMetadata(parsedName, parsedVersion, authOptions);

    if (!metadataResult.success) {
      return handleMetadataFailure(metadataResult, parsedName, parsedVersion);
    }

    const { response, context } = metadataResult;
    const registryUrl = context.registryUrl;
    const profile = context.profile;
    const versionToPull = response.version.version;

    console.log(`📥 Pulling formula '${parsedName}' from remote registry...`);
    console.log(`📦 Version: ${parsedVersion ?? 'latest'} (resolved: ${versionToPull})`);
    console.log(`🔑 Profile: ${profile}`);
    console.log('');

    console.log('🔍 Querying registry for formula...');
    console.log('✓ Formula found in registry');
    console.log(`  • Name: ${response.formula.name}`);
    console.log(`  • Version: ${versionToPull}`);
    console.log(`  • Description: ${response.formula.description || '(no description)'}`);
    console.log(`  • Size: ${formatFileSize(response.version.tarballSize)}`);
    const keywords = Array.isArray(response.formula.keywords) ? response.formula.keywords : [];
    if (keywords.length > 0) {
      console.log(`  • Keywords: ${keywords.join(', ')}`);
    }
    console.log(`  • Private: ${response.formula.isPrivate ? 'Yes' : 'No'}`);
    console.log(`  • Created: ${new Date(response.version.createdAt).toLocaleString()}`);

    const localVersionExists = await hasFormulaVersion(parsedName, versionToPull);
    if (localVersionExists) {
      console.log(`⚠️  Version '${versionToPull}' of formula '${parsedName}' already exists locally`);
      console.log('');

      const shouldProceed = await promptOverwriteConfirmation(parsedName, versionToPull);
      if (!shouldProceed) {
        throw new UserCancellationError('User declined to overwrite existing formula version');
      }
      console.log('');
    }

    // Check if any version of the formula exists (for informational purposes)
    const localExists = await formulaManager.formulaExists(parsedName);
    if (localExists && !localVersionExists) {
      console.log(`ℹ️  Formula '${parsedName}' has other versions locally`);
      console.log('Pulling will add a new version.');
      console.log('');
    }

    console.log('📥 Downloading formula tarball...');
    const pullResult = await pullFormulaFromRemote(parsedName, parsedVersion, {
      ...authOptions,
      preFetchedResponse: response,
      httpClient: context.httpClient
    });

    if (!pullResult.success) {
      return handleMetadataFailure(pullResult, parsedName, parsedVersion);
    }

    const extracted = pullResult.extracted;

    console.log('✅ Pull successful');
    console.log('');
    console.log('📊 Formula Details:');
    console.log(`  • Name: ${pullResult.response.formula.name}`);
    console.log(`  • Version: ${pullResult.response.version.version}`);
    console.log(`  • Files: ${extracted.files.length}`);
    console.log(`  • Size: ${formatFileSize(pullResult.response.version.tarballSize)}`);
    console.log(`  • Checksum: ${extracted.checksum.substring(0, 16)}...`);
    console.log('');
    console.log('🎯 Next steps:');
    console.log(`  g0 show ${pullResult.response.formula.name}         # View formula details`);
    console.log(`  g0 install ${pullResult.response.formula.name}     # Install formula to current project`);
    
    return {
      success: true,
      data: {
        formulaName: pullResult.response.formula.name,
        version: pullResult.response.version.version,
        formulaId: pullResult.response.formula._id,
        versionId: pullResult.response.version._id,
        files: extracted.files.length,
        size: pullResult.response.version.tarballSize,
        checksum: extracted.checksum,
        registry: registryUrl,
        profile,
        isPrivate: pullResult.response.formula.isPrivate,
        downloadUrl: pullResult.response.downloadUrl,
        message: 'Formula pulled and installed successfully'
      }
    };
  } catch (error) {
    logger.debug('Pull command failed', { error, formulaName: parsedName });
    
    return handleUnexpectedError(error, parsedName, parsedVersion);
  }
}

/**
 * Setup the pull command
 */
export function setupPullCommand(program: Command): void {
  program
    .command('pull')
    .description('Pull a formula from remote registry. Supports formula@version syntax.')
    .argument('<formula-name>', 'name of the formula to pull. Supports formula@version syntax.')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (formulaName: string, options: PullOptions) => {
      const result = await pullFormulaCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Pull operation failed');
      }
    }));
}

function handleMetadataFailure(
  failure: RemotePullFailure,
  formulaName: string,
  requestedVersion?: string
): CommandResult {
  switch (failure.reason) {
    case 'not-found':
      console.error(`❌ Formula '${formulaName}' not found in registry`);
      if (requestedVersion) {
        console.log(`Version '${requestedVersion}' does not exist.`);
      } else {
        console.log('Formula does not exist in the registry.');
      }
      console.log('');
      console.log('💡 Try one of these options:');
      console.log('  • Check the formula name spelling');
      console.log('  • Use g0 search to find available formulas');
      console.log('  • Verify you have access to this formula if it\'s private');
      return { success: false, error: 'Formula not found' };
    case 'access-denied':
      console.error(failure.message);
      console.log('');
      if (failure.statusCode === 403) {
        console.log('💡 This may be a private formula. Ensure you have VIEWER permissions.');
      }
      console.log('💡 To configure authentication:');
      console.log('  g0 configure');
      console.log('  g0 configure --profile <name>');
      return { success: false, error: 'Access denied' };
    case 'network':
      console.log('');
      console.log('💡 Try one of these options:');
      console.log('  • Check your internet connection');
      console.log('  • Try again (temporary network issue)');
      console.log('  • Set G0_API_TIMEOUT environment variable for longer timeout');
      return { success: false, error: 'Download failed' };
    case 'integrity':
      console.error(`❌ Formula integrity verification failed: ${failure.message}`);
      console.log('');
      console.log('💡 The downloaded formula may be corrupted. Try pulling again.');
      return { success: false, error: 'Integrity verification failed' };
    default:
      return { success: false, error: failure.message };
  }
}

function handleUnexpectedError(error: unknown, formulaName: string, requestedVersion?: string): CommandResult {
  if (error && typeof error === 'object' && 'success' in error) {
    return handleMetadataFailure(error as RemotePullFailure, formulaName, requestedVersion);
  }

  if (error instanceof Error) {
    return handleMetadataFailure({
      success: false,
      reason: 'unknown',
      message: error.message,
      error
    }, formulaName, requestedVersion);
  }

  return handleMetadataFailure({
    success: false,
    reason: 'unknown',
    message: 'Unknown error occurred',
    error
  }, formulaName, requestedVersion);
}

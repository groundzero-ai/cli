import { Command } from 'commander';
import { PullOptions, CommandResult } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import { hasFormulaVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { showBetaRegistryMessage } from '../utils/messages.js';
import { promptOverwriteConfirmation } from '../utils/prompts.js';
import { formatFileSize } from '../utils/formatters.js';
import { fetchRemoteFormulaMetadata, pullFormulaFromRemote, pullDownloadsBatchFromRemote, RemotePullFailure } from '../core/remote-pull.js';
import { RemoteFormulaMetadataResult, RemotePullContext } from '../core/remote-pull.js';
import { PullFormulaResponse } from '../types/api.js';
import { Spinner } from '../utils/spinner.js';
import { planRemoteDownloadsForFormula } from '../core/install/remote-flow.js';
import { recordBatchOutcome } from '../core/install/remote-reporting.js';

/**
 * Fetch formula metadata with spinner and error handling
 */
async function fetchFormulaMetadata(
  parsedName: string,
  parsedVersion: string | undefined,
  pullOptions: { profile?: string; apiKey?: string; recursive: boolean }
): Promise<RemoteFormulaMetadataResult> {
  const metadataSpinner = new Spinner('Querying registry for formula...');
  metadataSpinner.start();

  try {
    const result = await fetchRemoteFormulaMetadata(parsedName, parsedVersion, pullOptions);
    metadataSpinner.stop();
    return result;
  } catch (error) {
    metadataSpinner.stop();
    throw error;
  }
}

/**
 * Display formula information and warnings
 */
function displayFormulaInfo(
  response: PullFormulaResponse,
  parsedVersion: string | undefined,
  versionToPull: string,
  profile: string
): void {
  const inaccessibleDownloads = (response.downloads ?? []).filter((download: any) => !download.downloadUrl);
  if (inaccessibleDownloads.length > 0) {
    console.log(`⚠️  Skipping ${inaccessibleDownloads.length} downloads:`);
    inaccessibleDownloads.forEach((download: any) => {
      console.log(`  • ${download.name}: not found or insufficient permissions`);
    });
    console.log('');
  }

  console.log('✓ Formula found in registry');
  console.log(`✓ Version: ${parsedVersion ?? 'latest'} (resolved: ${versionToPull})`);
  console.log(`✓ Profile: ${profile}`);
  console.log('');
}

/**
 * Handle version existence checks and overwrite confirmation
 */
async function handleVersionChecks(
  parsedName: string,
  versionToPull: string
): Promise<void> {
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
    console.log(`✓ Formula '${parsedName}' has other versions locally`);
    console.log('Pulling will add a new version.');
    console.log('');
  }
}

/**
 * Perform recursive pull with batch downloading
 */
async function performRecursivePull(
  parsedName: string,
  versionToPull: string,
  response: PullFormulaResponse,
  context: RemotePullContext,
  registryUrl: string,
  profile: string
): Promise<{ formulaName: string; version: string; files: number; size: number; checksum: string; registry: string; profile: string; isPrivate: boolean; downloadUrl: string; message: string }> {
  const { downloadKeys, warnings: planWarnings } = await planRemoteDownloadsForFormula({ success: true, context, response }, { forceRemote: true, dryRun: false });

  if (planWarnings.length > 0) {
    planWarnings.forEach(warning => console.log(`⚠️  ${warning}`));
    console.log('');
  }

  if (downloadKeys.size === 0) {
    console.log('✓ All formulas already exist locally, nothing to pull');
    console.log('');
    return {
      formulaName: parsedName,
      version: versionToPull,
      files: 0,
      size: 0,
      checksum: '',
      registry: registryUrl,
      profile,
      isPrivate: response.formula.isPrivate,
      downloadUrl: '',
      message: 'All formulas already exist locally'
    };
  }

  const downloadSpinner = new Spinner(`Downloading ${downloadKeys.size} formula(s) from remote registry...`);
  downloadSpinner.start();

  try {
    const batchResult = await pullDownloadsBatchFromRemote(response, {
      httpClient: context.httpClient,
      profile: context.profile,
      dryRun: false,
      filter: (dependencyName, dependencyVersion) => {
        const downloadKey = `${dependencyName}@${dependencyVersion}`;
        return downloadKeys.has(downloadKey);
      }
    });
    downloadSpinner.stop();

    recordBatchOutcome('Pulled formulas', batchResult, [], false);

    if (!batchResult.success) {
      throw {
        success: false,
        reason: 'network',
        message: `Failed to pull ${batchResult.failed.length} formula(s)`
      } as RemotePullFailure;
    }

    const mainFormulaResult = batchResult.pulled.find(item => item.name === parsedName && item.version === versionToPull);

    return {
      formulaName: parsedName,
      version: versionToPull,
      files: mainFormulaResult ? 0 : 0,
      size: response.version.tarballSize,
      checksum: '',
      registry: registryUrl,
      profile,
      isPrivate: response.formula.isPrivate,
      downloadUrl: mainFormulaResult?.downloadUrl || '',
      message: `Successfully pulled ${batchResult.pulled.length} formula(s) (${batchResult.failed.length} failed)`
    };
  } catch (error) {
    downloadSpinner.stop();
    throw error;
  }
}

/**
 * Perform single formula pull
 */
async function performSinglePull(
  parsedName: string,
  parsedVersion: string | undefined,
  response: PullFormulaResponse,
  context: RemotePullContext,
  pullOptions: { profile?: string; apiKey?: string; recursive: boolean },
  registryUrl: string,
  profile: string
): Promise<{ formulaName: string; version: string; files: number; size: number; checksum: string; registry: string; profile: string; isPrivate: boolean; downloadUrl: string; message: string }> {
  const downloadSpinner = new Spinner('Downloading formula tarball...');
  downloadSpinner.start();

  try {
    const pullResult = await pullFormulaFromRemote(parsedName, parsedVersion, {
      ...pullOptions,
      preFetchedResponse: response,
      httpClient: context.httpClient
    });
    downloadSpinner.stop();

    if (!pullResult.success) {
      throw pullResult;
    }

    const extracted = pullResult.extracted;

    return {
      formulaName: pullResult.response.formula.name,
      version: pullResult.response.version.version,
      files: extracted.files.length,
      size: pullResult.response.version.tarballSize,
      checksum: extracted.checksum,
      registry: registryUrl,
      profile,
      isPrivate: pullResult.response.formula.isPrivate,
      downloadUrl: pullResult.downloadUrl,
      message: 'Formula pulled and installed successfully'
    };
  } catch (error) {
    downloadSpinner.stop();
    throw error;
  }
}

/**
 * Display pull results
 */
function displayPullResults(
  result: { formulaName: string; version: string; files: number; size: number; checksum: string; registry: string; profile: string; isPrivate: boolean; downloadUrl: string; message: string },
  response: PullFormulaResponse
): void {
  console.log('✓ Pull successful');
  console.log('');
  console.log('✓ Formula Details:');
  console.log(`  • Name: ${result.formulaName}`);
  console.log(`  • Version: ${result.version}`);
  console.log(`  • Description: ${response.formula.description || '(no description)'}`);
  console.log(`  • Size: ${formatFileSize(result.size)}`);
  const keywords = Array.isArray(response.formula.keywords) ? response.formula.keywords : [];
  if (keywords.length > 0) {
    console.log(`  • Keywords: ${keywords.join(', ')}`);
  }
  console.log(`  • Private: ${result.isPrivate ? 'Yes' : 'No'}`);
  console.log(`  • Files: ${result.files}`);
  if (result.checksum) {
    console.log(`  • Checksum: ${result.checksum.substring(0, 16)}...`);
  }
  console.log('');
  console.log('✓ Next steps:');
  console.log(`  opn show ${result.formulaName}         # View formula details`);
  console.log(`  opn install ${result.formulaName}     # Install formula to current project`);
}

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
    const pullOptions = {
      profile: options.profile,
      apiKey: options.apiKey,
      recursive: !!options.recursive,
    };

    console.log(`✓ Pulling formula '${parsedName}' from remote registry...`);
    console.log(`✓ Version: ${parsedVersion ?? 'latest'}`);
    console.log('');

    // Fetch formula metadata
    const metadataResult = await fetchFormulaMetadata(parsedName, parsedVersion, pullOptions);

    if (!metadataResult.success) {
      return handleMetadataFailure(metadataResult, parsedName, parsedVersion);
    }

    const { response, context } = metadataResult;
    const registryUrl = context.registryUrl;
    const profile = context.profile;
    const versionToPull = response.version.version;

    // Display formula information
    displayFormulaInfo(response, parsedVersion, versionToPull, profile);

    // Handle version checks and overwrite confirmation (only for non-recursive pulls)
    if (!options.recursive) {
      await handleVersionChecks(parsedName, versionToPull);
    }

    // Perform the actual pull operation
    const result = options.recursive
      ? await performRecursivePull(parsedName, versionToPull, response, context, registryUrl, profile)
      : await performSinglePull(parsedName, parsedVersion, response, context, pullOptions, registryUrl, profile);

    // Display results
    displayPullResults(result, response);

    return {
      success: true,
      data: result
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
    .option('--recursive', 'include dependency metadata (no additional downloads)')
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
      console.log('  • Use opn search to find available formulas');
      console.log('  • Verify you have access to this formula if it\'s private');
      return { success: false, error: 'Formula not found' };
    case 'access-denied':
      console.error(failure.message);
      console.log('');
      if (failure.statusCode === 403) {
        console.log('💡 This may be a private formula. Ensure you have VIEWER permissions.');
      }
      console.log('💡 To configure authentication:');
      console.log('  opn configure');
      console.log('  opn configure --profile <name>');
      return { success: false, error: 'Access denied' };
    case 'network':
      console.log('');
      console.log('💡 Try one of these options:');
      console.log('  • Check your internet connection');
      console.log('  • Try again (temporary network issue)');
      console.log('  • Set OPENPACKAGEAPI_TIMEOUT environment variable for longer timeout');
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

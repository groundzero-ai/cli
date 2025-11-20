import { Command } from 'commander';
import { PullOptions, CommandResult } from '../types/index.js';
import { packageManager } from '../core/package.js';
import { hasPackageVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { parsePackageInput } from '../utils/package-name.js';
import { showBetaRegistryMessage } from '../utils/messages.js';
import { promptOverwriteConfirmation } from '../utils/prompts.js';
import { formatFileSize } from '../utils/formatters.js';
import { fetchRemotePackageMetadata, pullPackageFromRemote, pullDownloadsBatchFromRemote, RemotePullFailure } from '../core/remote-pull.js';
import { RemotePackageMetadataResult, RemotePullContext } from '../core/remote-pull.js';
import { PullPackageResponse } from '../types/api.js';
import { Spinner } from '../utils/spinner.js';
import { planRemoteDownloadsForPackage } from '../core/install/remote-flow.js';
import { recordBatchOutcome } from '../core/install/remote-reporting.js';

/**
 * Fetch package metadata with spinner and error handling
 */
async function fetchPackageMetadata(
  parsedName: string,
  parsedVersion: string | undefined,
  pullOptions: { profile?: string; apiKey?: string; recursive: boolean }
): Promise<RemotePackageMetadataResult> {
  const metadataSpinner = new Spinner('Querying registry for package...');
  metadataSpinner.start();

  try {
    const result = await fetchRemotePackageMetadata(parsedName, parsedVersion, pullOptions);
    metadataSpinner.stop();
    return result;
  } catch (error) {
    metadataSpinner.stop();
    throw error;
  }
}

/**
 * Display package information and warnings
 */
function displayPackageInfo(
  response: PullPackageResponse,
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

  console.log('✓ Package found in registry');
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
  const localVersionExists = await hasPackageVersion(parsedName, versionToPull);
  if (localVersionExists) {
    console.log(`⚠️  Version '${versionToPull}' of package '${parsedName}' already exists locally`);
    console.log('');

    const shouldProceed = await promptOverwriteConfirmation(parsedName, versionToPull);
    if (!shouldProceed) {
      throw new UserCancellationError('User declined to overwrite existing package version');
    }
    console.log('');
  }

  // Check if any version of the package exists (for informational purposes)
  const localExists = await packageManager.packageExists(parsedName);
  if (localExists && !localVersionExists) {
    console.log(`✓ Package '${parsedName}' has other versions locally`);
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
  response: PullPackageResponse,
  context: RemotePullContext,
  registryUrl: string,
  profile: string
): Promise<{ packageName: string; version: string; files: number; size: number; checksum: string; registry: string; profile: string; isPrivate: boolean; downloadUrl: string; message: string }> {
  const { downloadKeys, warnings: planWarnings } = await planRemoteDownloadsForPackage({ success: true, context, response }, { forceRemote: true, dryRun: false });

  if (planWarnings.length > 0) {
    planWarnings.forEach(warning => console.log(`⚠️  ${warning}`));
    console.log('');
  }

  if (downloadKeys.size === 0) {
    console.log('✓ All packages already exist locally, nothing to pull');
    console.log('');
    return {
      packageName: parsedName,
      version: versionToPull,
      files: 0,
      size: 0,
      checksum: '',
      registry: registryUrl,
      profile,
      isPrivate: response.package.isPrivate,
      downloadUrl: '',
      message: 'All packages already exist locally'
    };
  }

  const downloadSpinner = new Spinner(`Downloading ${downloadKeys.size} package(s) from remote registry...`);
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

    recordBatchOutcome('Pulled packages', batchResult, [], false);

    if (!batchResult.success) {
      throw {
        success: false,
        reason: 'network',
        message: `Failed to pull ${batchResult.failed.length} package(s)`
      } as RemotePullFailure;
    }

    const mainPackageResult = batchResult.pulled.find(item => item.name === parsedName && item.version === versionToPull);

    return {
      packageName: parsedName,
      version: versionToPull,
      files: mainPackageResult ? 0 : 0,
      size: response.version.tarballSize,
      checksum: '',
      registry: registryUrl,
      profile,
      isPrivate: response.package.isPrivate,
      downloadUrl: mainPackageResult?.downloadUrl || '',
      message: `Successfully pulled ${batchResult.pulled.length} package(s) (${batchResult.failed.length} failed)`
    };
  } catch (error) {
    downloadSpinner.stop();
    throw error;
  }
}

/**
 * Perform single package pull
 */
async function performSinglePull(
  parsedName: string,
  parsedVersion: string | undefined,
  response: PullPackageResponse,
  context: RemotePullContext,
  pullOptions: { profile?: string; apiKey?: string; recursive: boolean },
  registryUrl: string,
  profile: string
): Promise<{ packageName: string; version: string; files: number; size: number; checksum: string; registry: string; profile: string; isPrivate: boolean; downloadUrl: string; message: string }> {
  const downloadSpinner = new Spinner('Downloading package tarball...');
  downloadSpinner.start();

  try {
    const pullResult = await pullPackageFromRemote(parsedName, parsedVersion, {
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
      packageName: pullResult.response.package.name,
      version: pullResult.response.version.version,
      files: extracted.files.length,
      size: pullResult.response.version.tarballSize,
      checksum: extracted.checksum,
      registry: registryUrl,
      profile,
      isPrivate: pullResult.response.package.isPrivate,
      downloadUrl: pullResult.downloadUrl,
      message: 'Package pulled and installed successfully'
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
  result: { packageName: string; version: string; files: number; size: number; checksum: string; registry: string; profile: string; isPrivate: boolean; downloadUrl: string; message: string },
  response: PullPackageResponse
): void {
  console.log('✓ Pull successful');
  console.log('');
  console.log('✓ Package Details:');
  console.log(`  • Name: ${result.packageName}`);
  console.log(`  • Version: ${result.version}`);
  console.log(`  • Description: ${response.package.description || '(no description)'}`);
  console.log(`  • Size: ${formatFileSize(result.size)}`);
  const keywords = Array.isArray(response.package.keywords) ? response.package.keywords : [];
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
  console.log(`  opkg show ${result.packageName}         # View package details`);
  console.log(`  opkg install ${result.packageName}     # Install package to current project`);
}

/**
 * Pull package command implementation
 */
async function pullPackageCommand(
  packageInput: string,
  options: PullOptions
): Promise<CommandResult> {
  const { name: parsedName, version: parsedVersion } = parsePackageInput(packageInput);
  logger.info(`Pulling package '${parsedName}' from remote registry`, { options });

  showBetaRegistryMessage();

  try {
    const pullOptions = {
      profile: options.profile,
      apiKey: options.apiKey,
      recursive: !!options.recursive,
    };

    console.log(`✓ Pulling package '${parsedName}' from remote registry...`);
    console.log(`✓ Version: ${parsedVersion ?? 'latest'}`);
    console.log('');

    // Fetch package metadata
    const metadataResult = await fetchPackageMetadata(parsedName, parsedVersion, pullOptions);

    if (!metadataResult.success) {
      return handleMetadataFailure(metadataResult, parsedName, parsedVersion);
    }

    const { response, context } = metadataResult;
    const registryUrl = context.registryUrl;
    const profile = context.profile;
    const versionToPull = response.version.version;

    // Display package information
    displayPackageInfo(response, parsedVersion, versionToPull, profile);

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
    logger.debug('Pull command failed', { error, packageName: parsedName });

    return handleUnexpectedError(error, parsedName, parsedVersion);
  }
}

/**
 * Setup the pull command
 */
export function setupPullCommand(program: Command): void {
  program
    .command('pull')
    .description('Pull a package from remote registry. Supports package@version syntax.')
    .argument('<package-name>', 'name of the package to pull. Supports package@version syntax.')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .option('--recursive', 'include dependency metadata (no additional downloads)')
    .action(withErrorHandling(async (packageName: string, options: PullOptions) => {
      const result = await pullPackageCommand(packageName, options);
      if (!result.success) {
        throw new Error(result.error || 'Pull operation failed');
      }
    }));
}

function handleMetadataFailure(
  failure: RemotePullFailure,
  packageName: string,
  requestedVersion?: string
): CommandResult {
  switch (failure.reason) {
    case 'not-found':
      console.error(`❌ Package '${packageName}' not found in registry`);
      if (requestedVersion) {
        console.log(`Version '${requestedVersion}' does not exist.`);
      } else {
        console.log('Package does not exist in the registry.');
      }
      console.log('');
      console.log('💡 Try one of these options:');
      console.log('  • Check the package name spelling');
      console.log('  • Use opkg search to find available packages');
      console.log('  • Verify you have access to this package if it\'s private');
      return { success: false, error: 'Package not found' };
    case 'access-denied':
      console.error(failure.message);
      console.log('');
      if (failure.statusCode === 403) {
        console.log('💡 This may be a private package. Ensure you have VIEWER permissions.');
      }
      console.log('💡 To configure authentication:');
      console.log('  opkg configure');
      console.log('  opkg configure --profile <name>');
      return { success: false, error: 'Access denied' };
    case 'network':
      console.log('');
      console.log('💡 Try one of these options:');
      console.log('  • Check your internet connection');
      console.log('  • Try again (temporary network issue)');
      console.log('  • Set OPENPACKAGEAPI_TIMEOUT environment variable for longer timeout');
      return { success: false, error: 'Download failed' };
    case 'integrity':
      console.error(`❌ Package integrity verification failed: ${failure.message}`);
      console.log('');
      console.log('💡 The downloaded package may be corrupted. Try pulling again.');
      return { success: false, error: 'Integrity verification failed' };
    default:
      return { success: false, error: failure.message };
  }
}

function handleUnexpectedError(error: unknown, packageName: string, requestedVersion?: string): CommandResult {
  if (error && typeof error === 'object' && 'success' in error) {
    return handleMetadataFailure(error as RemotePullFailure, packageName, requestedVersion);
  }

  if (error instanceof Error) {
    return handleMetadataFailure({
      success: false,
      reason: 'unknown',
      message: error.message,
      error
    }, packageName, requestedVersion);
  }

  return handleMetadataFailure({
    success: false,
    reason: 'unknown',
    message: 'Unknown error occurred',
    error
  }, packageName, requestedVersion);
}

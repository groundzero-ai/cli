import { Command } from 'commander';
import { InstallOptions, CommandResult, FormulaYml } from '../types/index.js';
import type { PullFormulaDownload } from '../types/api.js';
import { ResolvedFormula } from '../core/dependency-resolver.js';
import { ensureRegistryDirectories, hasFormulaVersion } from '../core/directory.js';
import { displayDependencyTree } from '../core/dependency-resolver.js';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import {
  CONFLICT_RESOLUTION,
  type Platform,
} from '../constants/index.js';
import {
  createPlatformDirectories
} from '../core/platforms.js';
import { normalizePlatforms } from '../utils/platform-mapper.js';
import { resolvePlatforms } from '../core/install/platform-resolution.js';
import {
  prepareInstallEnvironment,
  resolveDependenciesForInstall,
  processConflictResolution,
  performInstallationPhases,
  type DependencyResolutionResult,
  VersionResolutionAbortError
} from '../core/install/install-flow.js';
import {
  getLocalFormulaYmlPath,
  getAIDir,
  isRootFormula
} from '../utils/paths.js';
import { createBasicFormulaYml, addFormulaToYml, writeLocalFormulaMetadata } from '../utils/formula-management.js';
import {
  displayInstallationSummary,
  displayInstallationResults,
} from '../utils/formula-installation.js';
import {
  withOperationErrorHandling,
} from '../utils/error-handling.js';
import { installAiFiles } from '../utils/install-orchestrator.js';
import { extractFormulasFromConfig, getVersionInfoFromDependencyTree } from '../utils/install-helpers.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { promptOverwriteConfirmation } from '../utils/prompts.js';
import { formulaManager } from '../core/formula.js';
import {
  fetchRemoteFormulaMetadata,
  pullDownloadsBatchFromRemote,
  aggregateRecursiveDownloads,
  parseDownloadName,
  type RemoteBatchPullResult,
} from '../core/remote-pull.js';
import type { RemotePullFailure, RemoteFormulaMetadataSuccess } from '../core/remote-pull.js';
import { Spinner } from '../utils/spinner.js';

/**
 * Install all formulas from CWD formula.yml file
 * @param targetDir - Target directory for installation
 * @param options - Installation options including dev flag
 * @returns Command result with installation summary
 */
async function installAllFormulasCommand(
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  const cwd = process.cwd();
  logger.info(`Installing all formulas from formula.yml to: ${getAIDir(cwd)}`, { options });
  
  await ensureRegistryDirectories();
  
  // Auto-create basic formula.yml if it doesn't exist
  await createBasicFormulaYml(cwd);
  
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  
  const cwdConfig: FormulaYml = await withOperationErrorHandling(
    () => parseFormulaYml(formulaYmlPath),
    'parse formula.yml',
    formulaYmlPath
  );
  
  const allFormulasToInstall = extractFormulasFromConfig(cwdConfig);

  // Filter out any formulas that match the root formula name
  const formulasToInstall = [];
  const skippedRootFormulas = [];
  for (const formula of allFormulasToInstall) {
    if (await isRootFormula(cwd, formula.name)) {
      skippedRootFormulas.push(formula);
      console.log(`⚠️  Skipping ${formula.name} - it matches your project's root formula name`);
    } else {
      formulasToInstall.push(formula);
    }
  }

  if (formulasToInstall.length === 0) {
    if (skippedRootFormulas.length > 0) {
      console.log('✓ All formulas in formula.yml were skipped (matched root formula)');
      console.log('\nTips:');
      console.log('• Root formulas cannot be installed as dependencies');
      console.log('• Use "g0 install <formula-name>" to install external formulas');
      console.log('• Use "g0 save" to save your root formula to the registry');
    } else {
      console.log('⚠️ No formulas found in formula.yml');
      console.log('\nTips:');
      console.log('• Add formulas to the "formulas" array in formula.yml');
      console.log('• Add development formulas to the "dev-formulas" array in formula.yml');
      console.log('• Use "g0 install <formula-name>" to install a specific formula');
    }

    return { success: true, data: { installed: 0, skipped: skippedRootFormulas.length } };
  }

  console.log(`✓ Installing ${formulasToInstall.length} formulas from formula.yml:`);
  formulasToInstall.forEach(formula => {
    const prefix = formula.isDev ? '[dev] ' : '';
    const label = formula.version ? `${formula.name}@${formula.version}` : formula.name;
    console.log(`  • ${prefix}${label}`);
  });
  if (skippedRootFormulas.length > 0) {
    console.log(`  • ${skippedRootFormulas.length} formulas skipped (matched root formula)`);
  }
  console.log('');

  // Install formulas sequentially to avoid conflicts
  let totalInstalled = 0;
  let totalSkipped = 0;
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  const aggregateWarnings = new Set<string>();
  
  for (const formula of formulasToInstall) {
    try {
      const label = formula.version ? `${formula.name}@${formula.version}` : formula.name;
      console.log(`\n🔧 Installing ${formula.isDev ? '[dev] ' : ''}${label}...`);
      
      const installOptions: InstallOptions = { ...options, dev: formula.isDev };
      const result = await installFormulaCommand(
        formula.name,
        targetDir,
        installOptions,
        formula.version
      );
      
      if (result.success) {
        totalInstalled++;
        results.push({ name: formula.name, success: true });
        console.log(`✓ Successfully installed ${formula.name}`);

        if (result.warnings && result.warnings.length > 0) {
          result.warnings.forEach(warning => aggregateWarnings.add(warning));
        }
      } else {
        totalSkipped++;
        results.push({ name: formula.name, success: false, error: result.error });
        console.log(`❌ Failed to install ${formula.name}: ${result.error}`);
      }
    } catch (error) {
      if (error instanceof UserCancellationError) {
        throw error; // Re-throw to allow clean exit
      }
      totalSkipped++;
      results.push({ name: formula.name, success: false, error: String(error) });
      console.log(`❌ Failed to install ${formula.name}: ${error}`);
    }
  }
  
  displayInstallationSummary(totalInstalled, totalSkipped, formulasToInstall.length, results);

  if (aggregateWarnings.size > 0) {
    console.log('\n⚠️  Warnings during installation:');
    aggregateWarnings.forEach(warning => {
      console.log(`  • ${warning}`);
    });
  }
  
  const allSuccessful = totalSkipped === 0;
  
  return {
    success: allSuccessful,
    data: {
      installed: totalInstalled,
      skipped: totalSkipped,
      results
    },
    error: allSuccessful ? undefined : `${totalSkipped} formulas failed to install`,
    warnings: totalSkipped > 0 ? [`${totalSkipped} formulas failed to install`] : undefined
  };
}

/**
 * Handle dry run mode for formula installation
 */
async function handleDryRunMode(
  resolvedFormulas: ResolvedFormula[],
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  formulaYmlExists: boolean
): Promise<CommandResult> {
  console.log(`✓ Dry run - showing what would be installed:\n`);
  
  const mainFormula = resolvedFormulas.find(f => f.isRoot);
  if (mainFormula) {
    console.log(`Formula: ${mainFormula.name} v${mainFormula.version}`);
    if (mainFormula.formula.metadata.description) {
      console.log(`Description: ${mainFormula.formula.metadata.description}`);
    }
    console.log('');
  }
  
  // Show what would be installed to ai
  for (const resolved of resolvedFormulas) {
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.SKIPPED) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (user would decline overwrite)`);
      continue;
    }
    
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.KEPT) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    const dryRunResult = await installAiFiles(resolved.name, targetDir, options, resolved.version, true);
    
    if (dryRunResult.skipped) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    console.log(`✓ Would install to ai${targetDir !== '.' ? '/' + targetDir : ''}: ${dryRunResult.installedCount} files`);
    
    if (dryRunResult.overwritten) {
      console.log(`  ⚠️  Would overwrite existing directory`);
    }
  }
  
  // Show formula.yml update
  if (formulaYmlExists) {
    console.log(`\n✓ Would add to .groundzero/formula.yml: ${formulaName}@${resolvedFormulas.find(f => f.isRoot)?.version}`);
  } else {
    console.log('\nNo .groundzero/formula.yml found - skipping dependency addition');
  }
  
  return {
    success: true,
    data: { 
      dryRun: true, 
      resolvedFormulas,
      totalFormulas: resolvedFormulas.length
    }
  };
}

function formatFormulaLabel(formulaName: string, version?: string): string {
  return version ? `${formulaName}@${version}` : formulaName;
}

function createDownloadKey(name: string, version: string): string {
  return `${name}@${version}`;
}

async function computeMissingDownloadKeys(downloads: PullFormulaDownload[]): Promise<Set<string>> {
  const missingKeys = new Set<string>();

  for (const download of downloads) {
    if (!download?.name) {
      continue;
    }

    try {
      const { name, version } = parseDownloadName(download.name);
      if (!version) {
        continue;
      }

      const existsLocally = await hasFormulaVersion(name, version);
      if (!existsLocally) {
        missingKeys.add(createDownloadKey(name, version));
      }
    } catch (error) {
      logger.debug('Skipping download due to invalid name', { download: download.name, error });
    }
  }

  return missingKeys;
}

function recordBatchOutcome(
  label: string,
  result: RemoteBatchPullResult,
  warnings: string[],
  dryRun: boolean
): void {
  if (result.warnings) {
    warnings.push(...result.warnings);
  }

  const successful = result.pulled.map(item => createDownloadKey(item.name, item.version));
  const failed = result.failed.map(item => ({
    key: createDownloadKey(item.name, item.version),
    error: item.error ?? 'Unknown error'
  }));

  if (dryRun) {
    if (successful.length > 0) {
      console.log(`↪ Would ${label}: ${successful.join(', ')}`);
    }

    if (failed.length > 0) {
      for (const failure of failed) {
        const message = `Dry run: would fail to ${label} ${failure.key}: ${failure.error}`;
        console.log(`⚠️  ${message}`);
        warnings.push(message);
      }
    }

    return;
  }

  if (successful.length > 0) {
    console.log(`✓ ${label}: ${successful.length}`);
      for (const key of successful) {
        console.log(`   ├── ${key}`);
      }
  }

  if (failed.length > 0) {
    for (const failure of failed) {
      const message = `Failed to ${label} ${failure.key}: ${failure.error}`;
      console.log(`⚠️  ${message}`);
      warnings.push(message);
    }
  }
}

function describeRemoteFailure(label: string, failure: RemotePullFailure): string {
  switch (failure.reason) {
    case 'not-found':
      return `Formula '${label}' not found in remote registry`;
    case 'access-denied':
      return failure.message || `Access denied pulling ${label}`;
    case 'network':
      return failure.message || `Network error pulling ${label}`;
    case 'integrity':
      return failure.message || `Integrity check failed pulling ${label}`;
    default:
      return failure.message || `Failed to pull ${label}`;
  }
}

/**
 * Install formula command implementation with recursive dependency resolution
 * @param formulaName - Name of the formula to install
 * @param targetDir - Target directory for installation
 * @param options - Installation options including force, dry-run, and dev flags
 * @param version - Specific version to install (optional)
 * @returns Command result with detailed installation information
 */
async function installFormulaCommand(
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  version?: string
): Promise<CommandResult> {
  const cwd = process.cwd();

  if (await isRootFormula(cwd, formulaName)) {
    console.log(`⚠️  Cannot install ${formulaName} - it matches your project's root formula name`);
    console.log(`   This would create a circular dependency.`);
    console.log(`💡 Tip: Use 'g0 install' without specifying a formula name to install all formulas`);
    console.log(`   referenced in your .groundzero/formula.yml file.`);
    return {
      success: true,
      data: { skipped: true, reason: 'root formula' }
    };
  }

  logger.debug(`Installing formula '${formulaName}' with dependencies to: ${getAIDir(cwd)}`, { options });

  const dryRun = !!options.dryRun;
  const forceRemote = !!options.remote;
  const warnings: string[] = [];

  const mainFormulaAvailableLocally = version
    ? await hasFormulaVersion(formulaName, version)
    : await formulaManager.formulaExists(formulaName);

  const scenario = forceRemote
    ? 'force-remote'
    : mainFormulaAvailableLocally
      ? 'local-primary'
      : 'remote-primary';

  const { specifiedPlatforms } = await prepareInstallEnvironment(cwd, options);

  let resolvedFormulas: ResolvedFormula[] = [];
  let missingFormulas: string[] = [];

  const resolveDependenciesOutcome = async (): Promise<
    | { success: true; data: DependencyResolutionResult }
    | { success: false; commandResult: CommandResult }
  > => {
    try {
      const data = await resolveDependenciesForInstall(formulaName, cwd, version, options);
      return { success: true, data };
  } catch (error) {
    if (error instanceof VersionResolutionAbortError) {
        return { success: false, commandResult: { success: false, error: error.message } };
    }

    if (
      error instanceof FormulaNotFoundError ||
      (error instanceof Error && (
        error.message.includes('not available in local registry') ||
        (error.message.includes('Formula') && error.message.includes('not found'))
      ))
    ) {
      console.log('❌ Formula not found');
        return { success: false, commandResult: { success: false, error: 'Formula not found' } };
    }

    throw error;
  }
  };

  if (scenario === 'local-primary') {
    const initialResolution = await resolveDependenciesOutcome();
    if (!initialResolution.success) {
      return initialResolution.commandResult;
    }

    resolvedFormulas = initialResolution.data.resolvedFormulas;
    missingFormulas = initialResolution.data.missingFormulas;

    if (missingFormulas.length > 0) {
      const uniqueMissing = Array.from(new Set(missingFormulas));
      const metadataResults: RemoteFormulaMetadataSuccess[] = [];

      const metadataSpinner = dryRun ? null : new Spinner(`Fetching metadata for ${uniqueMissing.length} missing formula(s)...`);
      if (metadataSpinner) metadataSpinner.start();

      try {
        for (const missingName of uniqueMissing) {
          let requiredVersion: string | undefined;
          try {
            const versionInfo = await getVersionInfoFromDependencyTree(missingName, resolvedFormulas);
            requiredVersion = versionInfo.requiredVersion;
          } catch (error) {
            logger.debug('Failed to determine required version for missing dependency', { missingName, error });
          }

          const metadataResult = await fetchRemoteFormulaMetadata(missingName, requiredVersion, { recursive: true });
          if (!metadataResult.success) {
            const message = describeRemoteFailure(formatFormulaLabel(missingName, requiredVersion), metadataResult);
            console.log(`⚠️  ${message}`);
            warnings.push(message);
            continue;
          }

          metadataResults.push(metadataResult);
        }
      } finally {
        if (metadataSpinner) metadataSpinner.stop();
      }

      if (metadataResults.length > 0) {
        const keysToDownload = new Set<string>();

        for (const metadata of metadataResults) {
          const aggregated = aggregateRecursiveDownloads([metadata.response]);
          const missingKeys = await computeMissingDownloadKeys(aggregated);
          missingKeys.forEach(key => keysToDownload.add(key));
        }

        if (keysToDownload.size > 0 || dryRun) {
          const spinner = dryRun ? null : new Spinner(`Pulling ${keysToDownload.size} missing dependency formula(s) from remote...`);
          if (spinner) spinner.start();

          const batchResults: RemoteBatchPullResult[] = [];
          try {
            const remainingKeys = new Set(keysToDownload);

            for (const metadata of metadataResults) {
              if (!dryRun && remainingKeys.size === 0) {
                break;
              }

              const batchResult = await pullDownloadsBatchFromRemote(metadata.response, {
                httpClient: metadata.context.httpClient,
                profile: metadata.context.profile,
                dryRun,
                filter: (dependencyName, dependencyVersion) => {
                  const key = createDownloadKey(dependencyName, dependencyVersion);
                  if (!keysToDownload.has(key)) {
                    return false;
                  }

                  if (dryRun) {
                    return true;
                  }

                  if (!remainingKeys.has(key)) {
                    return false;
                  }

                  remainingKeys.delete(key);
                  return true;
                }
              });

              batchResults.push(batchResult);
            }
          } finally {
            if (spinner) spinner.stop();
          }

          for (const batchResult of batchResults) {
            recordBatchOutcome('Pulled dependencies', batchResult, warnings, dryRun);
          }
        }

        const refreshedResolution = await resolveDependenciesOutcome();
        if (!refreshedResolution.success) {
          return refreshedResolution.commandResult;
        }

        resolvedFormulas = refreshedResolution.data.resolvedFormulas;
        missingFormulas = refreshedResolution.data.missingFormulas;
      }
    }
  } else {
    const metadataSpinner = dryRun ? null : new Spinner('Fetching formula metadata...');
    if (metadataSpinner) metadataSpinner.start();

    let metadataResult;
    try {
      metadataResult = await fetchRemoteFormulaMetadata(formulaName, version, { recursive: true });
    } finally {
      if (metadataSpinner) metadataSpinner.stop();
    }

    if (!metadataResult.success) {
      const message = describeRemoteFailure(formatFormulaLabel(formulaName, version), metadataResult);
      console.log(`❌ ${message}`);
      return { success: false, error: metadataResult.reason === 'not-found' ? 'Formula not found' : message };
    }

    const aggregatedDownloads = aggregateRecursiveDownloads([metadataResult.response]);
    const downloadKeys = new Set<string>();

    for (const download of aggregatedDownloads) {
      try {
        const { name: downloadName, version: downloadVersion } = parseDownloadName(download.name);
        const key = createDownloadKey(downloadName, downloadVersion);
        const existsLocally = await hasFormulaVersion(downloadName, downloadVersion);

        if (forceRemote) {
          let shouldDownload = true;
          if (existsLocally) {
            if (dryRun) {
              console.log(`↪ Would prompt to overwrite ${key}`);
        } else {
              console.log(`⚠️  ${key} already exists locally`);
              const shouldOverwrite = await promptOverwriteConfirmation(downloadName, downloadVersion);
              if (!shouldOverwrite) {
                const skipMessage = `Skipped overwrite for ${key}`;
                warnings.push(skipMessage);
                shouldDownload = false;
              }
            }
          }

          if (shouldDownload) {
            downloadKeys.add(key);
          }
        } else if (!existsLocally) {
          downloadKeys.add(key);
        }
      } catch (error) {
        logger.debug('Skipping download due to invalid identifier', { download: download.name, error });
      }
    }

    if (downloadKeys.size > 0 || dryRun) {
      const spinner = dryRun ? null : new Spinner(`Pulling ${downloadKeys.size} formula(s) from remote registry...`);
      if (spinner) spinner.start();

      let batchResult: RemoteBatchPullResult;
      try {
        batchResult = await pullDownloadsBatchFromRemote(metadataResult.response, {
          httpClient: metadataResult.context.httpClient,
          profile: metadataResult.context.profile,
          dryRun,
          filter: (dependencyName, dependencyVersion) => {
            const key = createDownloadKey(dependencyName, dependencyVersion);
            if (!downloadKeys.has(key)) {
              return false;
            }

            if (dryRun) {
              return true;
            }

            downloadKeys.delete(key);
            return true;
          }
        });
      } finally {
        if (spinner) spinner.stop();
      }

      recordBatchOutcome('Pulled from remote', batchResult, warnings, dryRun);
    }

    const finalResolution = await resolveDependenciesOutcome();
    if (!finalResolution.success) {
      return finalResolution.commandResult;
    }

    resolvedFormulas = finalResolution.data.resolvedFormulas;
    missingFormulas = finalResolution.data.missingFormulas;
  }

  if (missingFormulas.length > 0) {
    const missingSummary = `Missing formulas after pull: ${Array.from(new Set(missingFormulas)).join(', ')}`;
    console.log(`⚠️  ${missingSummary}`);
    warnings.push(missingSummary);
  }

  const conflictProcessing = await processConflictResolution(resolvedFormulas, options);
  if ('cancelled' in conflictProcessing) {
    console.log(`Installation cancelled by user`);
    return {
      success: true,
      data: {
        formulaName,
        targetDir: getAIDir(cwd),
        resolvedFormulas: [],
        totalFormulas: 0,
        installed: 0,
        skipped: 1,
        totalGroundzeroFiles: 0
      }
    };
  }

  const { finalResolvedFormulas, conflictResult } = conflictProcessing;

  displayDependencyTree(finalResolvedFormulas, true);

  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  const formulaYmlExists = await exists(formulaYmlPath);

  if (options.dryRun) {
    return await handleDryRunMode(finalResolvedFormulas, formulaName, targetDir, options, formulaYmlExists);
  }

  const finalPlatforms = await resolvePlatforms(cwd, specifiedPlatforms, { interactive: true });
  const createdDirs = await createPlatformDirectories(cwd, finalPlatforms as Platform[]);

  const mainFormula = finalResolvedFormulas.find((f: any) => f.isRoot);

  const installationOutcome = await performInstallationPhases({
    cwd,
    formulas: finalResolvedFormulas,
    platforms: finalPlatforms as Platform[],
    conflictResult,
    options,
    targetDir
  });

  for (const resolved of finalResolvedFormulas) {
    await writeLocalFormulaMetadata(cwd, resolved.name, resolved.formula.metadata);
  }

  if (formulaYmlExists && mainFormula) {
    await addFormulaToYml(cwd, formulaName, mainFormula.version, options.dev || false, version, true);
  }

  displayInstallationResults(
    formulaName,
    finalResolvedFormulas,
    { platforms: finalPlatforms, created: createdDirs },
    options,
    mainFormula,
    installationOutcome.allAddedFiles,
    installationOutcome.allUpdatedFiles,
    installationOutcome.rootFileResults,
    missingFormulas
  );

  return {
    success: true,
    data: {
      formulaName,
      targetDir: getAIDir(cwd),
      resolvedFormulas: finalResolvedFormulas,
      totalFormulas: finalResolvedFormulas.length,
      installed: installationOutcome.installedCount,
      skipped: installationOutcome.skippedCount,
      totalGroundzeroFiles: installationOutcome.totalGroundzeroFiles
    },
    warnings: warnings.length > 0 ? Array.from(new Set(warnings)) : undefined
  };
}


/**
 * Main install command router - handles both individual and bulk install
 * @param formulaName - Name of formula to install (optional, installs all if not provided)
 * @param targetDir - Target directory for installation
 * @param options - Installation options
 * @returns Command result with installation status and data
 */
async function installCommand(
  formulaName: string | undefined,
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  // If no formula name provided, install all from formula.yml
  if (!formulaName) {
    return await installAllFormulasCommand(targetDir, options);
  }

  // Parse formula name and version from input
  const { name, version: inputVersion } = parseFormulaInput(formulaName);

  // Install the specific formula with version
  return await installFormulaCommand(name, targetDir, options, inputVersion);
}

/**
 * Setup the install command
 * @param program - Commander program instance to register the command with
 */
export function setupInstallCommand(program: Command): void {
  program
    .command('install')
    .alias('i')
    .description('Install formulas from local registry to codebase at cwd. Supports versioning with formula@version syntax.')
    .argument('[formula-name]', 'name of the formula to install (optional - installs all from formula.yml if not specified). Supports formula@version syntax.')
    .argument('[target-dir]', 'target directory relative to cwd/ai for /ai files only (defaults to ai root)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--force', 'overwrite existing files')
    .option('--dev', 'add formula to dev-formulas instead of formulas')
    .option('--platforms <platforms...>', 'prepare specific platforms (e.g., cursor claudecode opencode)')
    .option('--remote', 'pull and install from remote registry, ignoring local versions')
    .action(withErrorHandling(async (formulaName: string | undefined, targetDir: string, options: InstallOptions) => {
      // Normalize platforms option early for downstream logic
      options.platforms = normalizePlatforms(options.platforms);
      const result = await installCommand(formulaName, targetDir, options);
      if (!result.success) {
        if (result.error === 'Formula not found') {
          // Handled case: already printed minimal message, do not bubble to global handler
          return;
        }
        throw new Error(result.error || 'Installation operation failed');
      }
    }));
}
import { Command } from 'commander';
import { InstallOptions, CommandResult, FormulaYml } from '../types/index.js';
import { ResolvedFormula } from '../core/dependency-resolver.js';
import { ensureRegistryDirectories, hasFormulaVersion, listFormulaVersions } from '../core/directory.js';
import { displayDependencyTree } from '../core/dependency-resolver.js';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import {
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
  performIndexBasedInstallationPhases,
  type DependencyResolutionResult,
  VersionResolutionAbortError
} from '../core/install/install-flow.js';
import {
  getLocalFormulaYmlPath,
  getAIDir,
  isRootFormula
} from '../utils/paths.js';
import { createBasicFormulaYml, addFormulaToYml, writeLocalFormulaFromRegistry } from '../utils/formula-management.js';
import {
  displayInstallationSummary,
  displayInstallationResults,
} from '../utils/formula-installation.js';
import { planConflictsForFormula } from '../utils/index-based-installer.js';
import {
  withOperationErrorHandling,
} from '../utils/error-handling.js';
import { extractFormulasFromConfig } from '../utils/install-helpers.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { formulaManager } from '../core/formula.js';
import { safePrompts } from '../utils/prompts.js';
import { isExactVersion, resolveVersionRange } from '../utils/version-ranges.js';
import {
  fetchRemoteFormulaMetadata,
  pullDownloadsBatchFromRemote,
  aggregateRecursiveDownloads,
  type RemoteBatchPullResult,
} from '../core/remote-pull.js';
import { Spinner } from '../utils/spinner.js';
import { createDownloadKey, computeMissingDownloadKeys } from '../core/install/download-keys.js';
import { fetchMissingDependencyMetadata, pullMissingDependencies, planRemoteDownloadsForFormula } from '../core/install/remote-flow.js';
import { recordBatchOutcome, describeRemoteFailure } from '../core/install/remote-reporting.js';
import { handleDryRunMode } from '../core/install/dry-run.js';
import { InstallScenario } from '../core/install/types.js';

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

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const normalizedPlatforms = normalizePlatforms(options.platforms);
  const resolvedPlatforms = await resolvePlatforms(cwd, normalizedPlatforms, { interactive });

  // Install formulas sequentially to avoid conflicts
  let totalInstalled = 0;
  let totalSkipped = 0;
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  const aggregateWarnings = new Set<string>();
  
  for (const formula of formulasToInstall) {
    try {
      const label = formula.version ? `${formula.name}@${formula.version}` : formula.name;

      const baseConflictDecisions = options.conflictDecisions
        ? { ...options.conflictDecisions }
        : undefined;

      const installOptions: InstallOptions = {
        ...options,
        dev: formula.isDev,
        resolvedPlatforms,
        conflictDecisions: baseConflictDecisions
      };

      let conflictPlanningVersion = formula.version;
      if (formula.version && !isExactVersion(formula.version)) {
        try {
          const localVersions = await listFormulaVersions(formula.name);
          conflictPlanningVersion = resolveVersionRange(formula.version, localVersions) ?? undefined;
        } catch {
          conflictPlanningVersion = undefined;
        }
      }

      if (conflictPlanningVersion) {
        try {
          const conflicts = await planConflictsForFormula(
            cwd,
            formula.name,
            conflictPlanningVersion,
            resolvedPlatforms
          );

          if (conflicts.length > 0) {
            const shouldPrompt = interactive && (!installOptions.conflictStrategy || installOptions.conflictStrategy === 'ask');

            if (shouldPrompt) {
              console.log(`\n⚠️  Detected ${conflicts.length} potential file conflict${conflicts.length === 1 ? '' : 's'} for ${label}.`);
              const preview = conflicts.slice(0, 5);
              for (const conflict of preview) {
                const ownerInfo = conflict.ownerFormula ? `owned by ${conflict.ownerFormula}` : 'already exists locally';
                console.log(`  • ${conflict.relPath} (${ownerInfo})`);
              }
              if (conflicts.length > preview.length) {
                console.log(`  • ... and ${conflicts.length - preview.length} more`);
              }

              const selection = await safePrompts({
                type: 'select',
                name: 'strategy',
                message: `Choose conflict handling for ${label}:`,
                choices: [
                  { title: 'Keep both (rename existing files)', value: 'keep-both' },
                  { title: 'Overwrite existing files', value: 'overwrite' },
                  { title: 'Skip conflicting files', value: 'skip' },
                  { title: 'Review individually', value: 'ask' }
                ],
                initial: installOptions.conflictStrategy === 'ask' ? 3 : 0
              });

              const chosenStrategy = (selection as any).strategy as InstallOptions['conflictStrategy'];
              installOptions.conflictStrategy = chosenStrategy;

              if (chosenStrategy === 'ask') {
                const decisions: Record<string, 'keep-both' | 'overwrite' | 'skip'> = {};
                for (const conflict of conflicts) {
                  const detail = await safePrompts({
                    type: 'select',
                    name: 'decision',
                    message: `${conflict.relPath}${conflict.ownerFormula ? ` (owned by ${conflict.ownerFormula})` : ''}:`,
                    choices: [
                      { title: 'Keep both (rename existing)', value: 'keep-both' },
                      { title: 'Overwrite existing', value: 'overwrite' },
                      { title: 'Skip (keep existing)', value: 'skip' }
                    ],
                    initial: 0
                  });
                  const decisionValue = (detail as any).decision as 'keep-both' | 'overwrite' | 'skip';
                  decisions[conflict.relPath] = decisionValue;
                }
                installOptions.conflictDecisions = decisions;
              }
            } else if (!interactive && (!installOptions.conflictStrategy || installOptions.conflictStrategy === 'ask')) {
              logger.warn(
                `Detected ${conflicts.length} potential conflict${conflicts.length === 1 ? '' : 's'} for ${label}, but running in non-interactive mode. Conflicting files will be skipped unless '--conflicts' is provided.`
              );
            }
          }
        } catch (planError) {
          logger.warn(`Failed to evaluate conflicts for ${label}: ${planError}`);
        }
      }

      console.log(`\n🔧 Installing ${formula.isDev ? '[dev] ' : ''}${label}...`);

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

  // 1) Validate root formula and early return
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

  const versionConstraint = version;

  let downloadVersion = versionConstraint;
  if (versionConstraint && !isExactVersion(versionConstraint)) {
    try {
      const localVersions = await listFormulaVersions(formulaName);
      downloadVersion = resolveVersionRange(versionConstraint, localVersions) ?? undefined;
    } catch {
      downloadVersion = undefined;
    }
  }

  const mainFormulaAvailableLocally = downloadVersion
    ? await hasFormulaVersion(formulaName, downloadVersion)
    : await formulaManager.formulaExists(formulaName);

  // 2) Determine install scenario
  const scenario: InstallScenario = forceRemote
    ? 'force-remote'
    : mainFormulaAvailableLocally
      ? 'local-primary'
      : 'remote-primary';

  // 3) Prepare env via prepareInstallEnvironment
  const { specifiedPlatforms } = await prepareInstallEnvironment(cwd, options);

  let resolvedFormulas: ResolvedFormula[] = [];
  let missingFormulas: string[] = [];

  const resolveDependenciesOutcome = async (): Promise<
    | { success: true; data: DependencyResolutionResult }
    | { success: false; commandResult: CommandResult }
  > => {
    try {
      const data = await resolveDependenciesForInstall(formulaName, cwd, versionConstraint, options);
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

  // 4) Resolve deps via resolveDependenciesForInstall (wrapped helper retained locally)
  // 5) If scenario is local-primary and there are missing deps
  if (scenario === 'local-primary') {
    const initialResolution = await resolveDependenciesOutcome();
    if (!initialResolution.success) {
      return initialResolution.commandResult;
    }

    resolvedFormulas = initialResolution.data.resolvedFormulas;
    missingFormulas = initialResolution.data.missingFormulas;

    if (missingFormulas.length > 0) {

      // Fetch metadata via fetchMissingDependencyMetadata
      const metadataResults = await fetchMissingDependencyMetadata(missingFormulas, resolvedFormulas, { dryRun, profile: options.profile, apiKey: options.apiKey });

      if (metadataResults.length > 0) {
        // Build keysToDownload with computeMissingDownloadKeys
        const keysToDownload = new Set<string>();
        for (const metadata of metadataResults) {
          const aggregated = aggregateRecursiveDownloads([metadata.response]);
          const missingKeys = await computeMissingDownloadKeys(aggregated);
          missingKeys.forEach((key: string) => keysToDownload.add(key));
        }

        // Pull batches via pullMissingDependencies and log with recordBatchOutcome
        const batchResults = await pullMissingDependencies(metadataResults, keysToDownload, { dryRun, profile: options.profile, apiKey: options.apiKey });
        for (const batchResult of batchResults) {
          recordBatchOutcome('Pulled dependencies', batchResult, warnings, dryRun);
        }

        // Re-resolve deps
        const refreshedResolution = await resolveDependenciesOutcome();
        if (!refreshedResolution.success) {
          return refreshedResolution.commandResult;
        }

        resolvedFormulas = refreshedResolution.data.resolvedFormulas;
        missingFormulas = refreshedResolution.data.missingFormulas;
      }
    }
  } else {
    // 6) Else (remote-primary / force-remote)

    // Fetch metadata for root
    const metadataSpinner = dryRun ? null : new Spinner('Fetching formula metadata...');
    if (metadataSpinner) metadataSpinner.start();

    let metadataResult;
    try {
      metadataResult = await fetchRemoteFormulaMetadata(formulaName, downloadVersion, { recursive: true, profile: options.profile, apiKey: options.apiKey });
    } finally {
      if (metadataSpinner) metadataSpinner.stop();
    }

    if (!metadataResult.success) {
      const requestedVersionLabel = downloadVersion ?? versionConstraint;
      const message = describeRemoteFailure(
        requestedVersionLabel ? `${formulaName}@${requestedVersionLabel}` : formulaName,
        metadataResult
      );
      console.log(`❌ ${message}`);
      return { success: false, error: metadataResult.reason === 'not-found' ? 'Formula not found' : message };
    }

    // Decide which downloads to pull (respecting forceRemote, prompts, dryRun)
    const { downloadKeys, warnings: planWarnings } = await planRemoteDownloadsForFormula(metadataResult, { forceRemote, dryRun });
    warnings.push(...planWarnings);

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

    // Resolve deps
    const finalResolution = await resolveDependenciesOutcome();
    if (!finalResolution.success) {
      return finalResolution.commandResult;
    }

    resolvedFormulas = finalResolution.data.resolvedFormulas;
    missingFormulas = finalResolution.data.missingFormulas;
  }

  // 7) Warn if still missing
  if (missingFormulas.length > 0) {
    const missingSummary = `Missing formulas after pull: ${Array.from(new Set(missingFormulas)).join(', ')}`;
    console.log(`⚠️  ${missingSummary}`);
    warnings.push(missingSummary);
  }

  // 8) Process conflicts
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

  // 9) If dryRun, delegate to handleDryRunMode and return
  if (options.dryRun) {
    return await handleDryRunMode(finalResolvedFormulas, formulaName, targetDir, options, formulaYmlExists);
  }

  // 10) Resolve platforms, create dirs, perform phases, write metadata, update formula.yml, display results, return
  const canPromptForPlatforms = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const finalPlatforms = options.resolvedPlatforms && options.resolvedPlatforms.length > 0
    ? options.resolvedPlatforms
    : await resolvePlatforms(cwd, specifiedPlatforms, { interactive: canPromptForPlatforms });
  const createdDirs = await createPlatformDirectories(cwd, finalPlatforms as Platform[]);

  const mainFormula = finalResolvedFormulas.find((f: any) => f.isRoot);

  const installationOutcome = await performIndexBasedInstallationPhases({
    cwd,
    formulas: finalResolvedFormulas,
    platforms: finalPlatforms as Platform[],
    conflictResult,
    options,
    targetDir
  });

  for (const resolved of finalResolvedFormulas) {
    await writeLocalFormulaFromRegistry(cwd, resolved.name, resolved.version);
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
    .option('--conflicts <strategy>', 'conflict handling strategy: keep-both, overwrite, skip, or ask')
    .option('--dev', 'add formula to dev-formulas instead of formulas')
    .option('--platforms <platforms...>', 'prepare specific platforms (e.g., cursor claudecode opencode)')
    .option('--remote', 'pull and install from remote registry, ignoring local versions')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (formulaName: string | undefined, targetDir: string, options: InstallOptions) => {
      // Normalize platforms option early for downstream logic
      options.platforms = normalizePlatforms(options.platforms);

      const commandOptions = options as InstallOptions & { conflicts?: string };
      const rawConflictStrategy = commandOptions.conflicts ?? options.conflictStrategy;
      if (rawConflictStrategy) {
        const normalizedStrategy = (rawConflictStrategy as string).toLowerCase();
        const allowedStrategies: InstallOptions['conflictStrategy'][] = ['keep-both', 'overwrite', 'skip', 'ask'];
        if (!allowedStrategies.includes(normalizedStrategy as InstallOptions['conflictStrategy'])) {
          throw new Error(`Invalid --conflicts value '${rawConflictStrategy}'. Use one of: keep-both, overwrite, skip, ask.`);
        }
        options.conflictStrategy = normalizedStrategy as InstallOptions['conflictStrategy'];
      }

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
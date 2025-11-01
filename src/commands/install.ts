import { Command } from 'commander';
import { InstallOptions, CommandResult, FormulaYml } from '../types/index.js';
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
  handleAvailabilityOutcome,
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
import { extractFormulasFromConfig } from '../utils/install-helpers.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { promptOverwriteConfirmation } from '../utils/prompts.js';
import { formulaManager } from '../core/formula.js';
import { fetchRemoteFormulaMetadata, pullFormulaFromRemote } from '../core/remote-pull.js';
import type { RemotePullFailure } from '../core/remote-pull.js';
import { Spinner } from '../utils/spinner.js';

type AvailabilityStatus = 'local' | 'pulled' | 'missing' | 'not-found' | 'failed';

interface AvailabilityResult {
  status: AvailabilityStatus;
  message?: string;
}

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
  
  const availabilityStates = await Promise.all(
    formulasToInstall.map(formula =>
      ensureFormulaAvailable(formula.name, formula.version, { dryRun: !!options.dryRun, forceRemote: !!options.remote })
    )
  );

  // Install formulas sequentially to avoid conflicts
  let totalInstalled = 0;
  let totalSkipped = 0;
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  
  for (let index = 0; index < formulasToInstall.length; index++) {
    const formula = formulasToInstall[index];
    const availability = availabilityStates[index];

    if (availability.status === 'not-found') {
      totalSkipped++;
      results.push({ name: formula.name, success: false, error: availability.message || 'Formula not found in remote registry' });
      continue;
    }

    if (availability.status === 'failed') {
      totalSkipped++;
      results.push({ name: formula.name, success: false, error: availability.message || 'Failed to prepare formula for installation' });
      continue;
    }

    if (availability.status === 'missing') {
      console.log(`🛠️  Dry run: skipping installation for ${formatFormulaLabel(formula.name, formula.version)} (formula not pulled)`);
      results.push({ name: formula.name, success: true });
      continue;
    }

    try {
      const label = formula.version ? `${formula.name}@${formula.version}` : formula.name;
      console.log(`\n🔧 Installing ${formula.isDev ? '[dev] ' : ''}${label}...`);
      
      const installOptions: InstallOptions = { ...options, dev: formula.isDev };
      const result = await installFormulaCommand(
        formula.name,
        targetDir,
        installOptions,
        formula.version,
        availability
      );
      
      if (result.success) {
        totalInstalled++;
        results.push({ name: formula.name, success: true });
        console.log(`✓ Successfully installed ${formula.name}`);
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

async function ensureFormulaAvailable(
  formulaName: string,
  version: string | undefined,
  options: { dryRun: boolean; forceRemote?: boolean }
): Promise<AvailabilityResult> {
  const label = formatFormulaLabel(formulaName, version);

  try {
    // Skip local checks if forceRemote is enabled
    if (!options.forceRemote) {
      if (version) {
        if (await hasFormulaVersion(formulaName, version)) {
          console.log(`✓ Using local ${label}`);
          return { status: 'local' };
        }
      } else if (await formulaManager.formulaExists(formulaName)) {
        console.log(`✓ Using local ${label}`);
        return { status: 'local' };
      }
    } else {
      // When forceRemote is enabled, still check if version exists locally and prompt for confirmation
      let localVersionExists = false;
      if (version) {
        localVersionExists = await hasFormulaVersion(formulaName, version);
      } else {
        localVersionExists = await formulaManager.formulaExists(formulaName);
      }

      if (localVersionExists) {
        console.log(`⚠️  Version '${version || 'latest'}' of formula '${formulaName}' already exists locally`);
        console.log('');

        const shouldProceed = await promptOverwriteConfirmation(formulaName, version || 'latest');
        if (!shouldProceed) {
          throw new UserCancellationError('User declined to overwrite existing formula version');
        }
        console.log('');
      }
    }

    const metadataResult = await fetchRemoteFormulaMetadata(formulaName, version);
    if (!metadataResult.success) {
      return mapFailureToAvailability(label, metadataResult);
    }

    const inaccessibleDownloads = (metadataResult.response.downloads ?? []).filter(download => !download.downloadUrl);
    if (inaccessibleDownloads.length > 0) {
      console.log(`⚠️  Skipping ${inaccessibleDownloads.length} downloads:`);
      inaccessibleDownloads.forEach(download => {
        console.log(`  • ${download.name}: not found or insufficient permissions`);
      });
      console.log('');
    }

    if (options.dryRun) {
      const action = options.forceRemote ? 'pull' : 'pull';
      console.log(`↪ Would ${action} ${label} from remote`);
      return { status: 'missing', message: `Dry run: would ${action} ${label}` };
    }

    const pullSpinner = new Spinner(`Pulling ${label} from remote registry...`);
    pullSpinner.start();
    
    let pullResult;
    try {
      pullResult = await pullFormulaFromRemote(formulaName, version, {
        preFetchedResponse: metadataResult.response,
        httpClient: metadataResult.context.httpClient,
        profile: metadataResult.context.profile,
        recursive: true, // Installations are always recursive
      });
      pullSpinner.stop();
    } catch (error) {
      pullSpinner.stop();
      throw error;
    }

    if (pullResult.success) {
      const resolvedLabel = formatFormulaLabel(pullResult.name, pullResult.version);
      console.log(`✓ Pulled ${resolvedLabel} from remote registry`);
      return { status: 'pulled' };
    }

    return mapFailureToAvailability(label, pullResult);
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to allow clean exit
    }
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Unexpected error ensuring ${label}: ${message}`);
    return { status: 'failed', message };
  }
}

function mapFailureToAvailability(label: string, failure: RemotePullFailure): AvailabilityResult {
  switch (failure.reason) {
    case 'not-found': {
      const message = `Formula '${label}' not found in remote registry`;
      console.log(`❌ ${message}`);
      return { status: 'not-found', message };
    }
    case 'access-denied': {
      const message = failure.message || `Access denied pulling ${label}`;
      console.log(`❌ ${message}`);
      console.log('   Use g0 configure to authenticate or check permissions.');
      return { status: 'failed', message };
    }
    case 'network': {
      const message = failure.message || `Network error pulling ${label}`;
      console.log(`❌ ${message}`);
      console.log('   Check your internet connection and try again.');
      return { status: 'failed', message };
    }
    case 'integrity': {
      const message = failure.message || `Integrity check failed pulling ${label}`;
      console.log(`❌ ${message}`);
      return { status: 'failed', message };
    }
    default: {
      const message = failure.message || `Failed to pull ${label}`;
      console.log(`❌ ${message}`);
      return { status: 'failed', message };
    }
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
  version?: string,
  availabilityHint?: AvailabilityResult
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
  const availability = availabilityHint ?? await ensureFormulaAvailable(formulaName, version, { dryRun, forceRemote });

  const availabilityResult = handleAvailabilityOutcome(availability, formulaName, version, cwd, targetDir);
  if (availabilityResult) {
    return availabilityResult;
  }

  const { specifiedPlatforms } = await prepareInstallEnvironment(cwd, options);

  let dependencyResult: DependencyResolutionResult;
  try {
    dependencyResult = await resolveDependenciesForInstall(formulaName, cwd, version, options);
  } catch (error) {
    if (error instanceof VersionResolutionAbortError) {
      return { success: false, error: error.message };
    }

    if (
      error instanceof FormulaNotFoundError ||
      (error instanceof Error && (
        error.message.includes('not available in local registry') ||
        (error.message.includes('Formula') && error.message.includes('not found'))
      ))
    ) {
      console.log('❌ Formula not found');
      return { success: false, error: 'Formula not found' };
    }

    throw error;
  }

  const { resolvedFormulas, missingFormulas } = dependencyResult;

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
    }
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
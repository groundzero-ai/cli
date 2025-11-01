import * as semver from 'semver';
import { Command } from 'commander';
import { InstallOptions, CommandResult, FormulaYml } from '../types/index.js';
import { ResolvedFormula } from '../core/dependency-resolver.js';
import { ensureRegistryDirectories, hasFormulaVersion } from '../core/directory.js';
import { gatherGlobalVersionConstraints, gatherRootVersionConstraints } from '../core/groundzero.js';
import { resolveDependencies, displayDependencyTree } from '../core/dependency-resolver.js';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, VersionConflictError, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import {
  CONFLICT_RESOLUTION,
  type Platform
} from '../constants/index.js';
import {
  createPlatformDirectories
} from '../core/platforms.js';
import { normalizePlatforms } from '../utils/platform-mapper.js';
import { resolvePlatforms } from '../core/install/platform-resolution.js';
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
import { installAiFiles, installAiFilesFromList } from '../utils/install-orchestrator.js';
import { extractFormulasFromConfig, resolveDependenciesWithOverrides } from '../utils/install-helpers.js';
import { checkAndHandleAllFormulaConflicts } from '../utils/install-conflict-handler.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { installIndexYmlDirectories } from '../utils/index-yml-based-installer.js';
import { discoverAndCategorizeFiles } from '../utils/install-file-discovery.js';
import { installFilesByIdWithMap } from '../utils/id-based-installer.js';
import { installRootFilesFromMap } from '../utils/root-file-installer.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { promptVersionSelection, promptOverwriteConfirmation } from '../utils/prompts.js';
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

  // Check if trying to install the root formula (circular dependency)
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

  if (availability.status === 'not-found') {
    console.log(`❌ Formula '${formulaName}' not found in remote registry`);
    return { success: false, error: `Formula '${formulaName}' not found in remote registry` };
  }

  if (availability.status === 'failed') {
    return { success: false, error: availability.message || 'Failed to prepare formula for installation' };
  }

  if (availability.status === 'missing') {
    console.log(`Dry run: would pull ${formatFormulaLabel(formulaName, version)} from remote before installation.`);
    return {
      success: true,
      data: {
        formulaName,
        targetDir: getAIDir(cwd),
        resolvedFormulas: [],
        totalFormulas: 0,
        installed: 0,
        skipped: 1,
        totalGroundzeroFiles: 0,
        dryRun: true
      },
      warnings: [`Dry run: ${formatFormulaLabel(formulaName, version)} not installed (formula unavailable locally)`]
    };
  }

  await ensureRegistryDirectories();
  
  // Auto-create basic formula.yml if it doesn't exist
  await createBasicFormulaYml(cwd);

  // Prepare platform directories early if user specified platforms
  const specifiedPlatforms = normalizePlatforms(options.platforms);
  if (specifiedPlatforms && specifiedPlatforms.length > 0 && !options.dryRun) {
    const earlyPlatforms = await resolvePlatforms(cwd, specifiedPlatforms, { interactive: false });
    await createPlatformDirectories(cwd, earlyPlatforms as Platform[]);
  }
  
  // Resolve complete dependency tree first, with conflict handling and persistence
  const globalConstraints = await gatherGlobalVersionConstraints(cwd);
  let resolvedFormulas: ResolvedFormula[];
  let missingFormulas: string[] = [];
  try {
    const rootConstraints = await gatherRootVersionConstraints(cwd);
    const result = await resolveDependencies(
      formulaName,
      cwd,
      true,
      new Set(),
      new Map(),
      version,
      new Map(),
      globalConstraints,
      rootConstraints
    );
    resolvedFormulas = result.resolvedFormulas;
    missingFormulas = result.missingFormulas;
  } catch (error) {
    if (error instanceof VersionConflictError) {
      // Decide version: if --force, take highest available; else prompt user to select
      const { details } = (error as any) || {};
      const depName = details?.formulaName || (error as any).details?.formulaName || (error as any).code;
      const name = (error as any).details?.formulaName || (error as any).details?.formula || formulaName; // fallback
      const available: string[] = details?.availableVersions || (error as any).details?.availableVersions || [];

      let chosenVersion: string | null = null;
      if (options.force) {
        // pick highest available version
        chosenVersion = available.sort((a, b) => semver.rcompare(a, b))[0] || null;
      } else {
        // ask user to pick a version from available
        chosenVersion = await promptVersionSelection(details?.formulaName || name, available, 'to install');
      }

      if (!chosenVersion) {
        return { success: false, error: `Unable to resolve version for ${(error as any).details?.formulaName || name}` };
      }

      // Persist chosen version by promoting to direct dependency in main formula.yml
      await addFormulaToYml(cwd, (error as any).details?.formulaName || name, chosenVersion!, false, chosenVersion!, true);

      // Recompute constraints (now includes the persisted version in root) and re-resolve
      const updatedConstraints = await gatherGlobalVersionConstraints(cwd);
      const overrideResult = await resolveDependenciesWithOverrides(
        formulaName,
        cwd,
        [],
        updatedConstraints,
        version
      );
      resolvedFormulas = overrideResult.resolvedFormulas;
      // Merge any new missing formulas
      missingFormulas = [...missingFormulas, ...overrideResult.missingFormulas];
    } else if (
      error instanceof FormulaNotFoundError ||
      (error instanceof Error && (
        error.message.includes('not available in local registry') ||
        (error.message.includes('Formula') && error.message.includes('not found'))
      ))
    ) {
      console.log('❌ Formula not found');
      return { success: false, error: 'Formula not found' };
    } else {
      throw error;
    }
  }

  // Check for conflicts with all formulas in the dependency tree
  const conflictResult = await checkAndHandleAllFormulaConflicts(resolvedFormulas as any, options);
  
  if (!conflictResult.shouldProceed) {
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
  
  // Filter out skipped formulas
  const finalResolvedFormulas = resolvedFormulas.filter(formula => 
    !conflictResult.skippedFormulas.includes(formula.name)
  );
    
  displayDependencyTree(finalResolvedFormulas, true);
  
  // Check if formula.yml exists (cache the result for later use)
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  const formulaYmlExists = await exists(formulaYmlPath);

  // Handle dry-run mode
  if (options.dryRun) {
    return await handleDryRunMode(finalResolvedFormulas, formulaName, targetDir, options, formulaYmlExists);
  }

  // Process resolved formulas (will be called with platforms later after detection)
  // Note: Platform files will be installed after platform detection below

  // Get main formula for formula.yml updates and display
  const mainFormula = finalResolvedFormulas.find((f: any) => f.isRoot);

  // Resolve platforms (specified > detected > prompt)
  const finalPlatforms = await resolvePlatforms(cwd, specifiedPlatforms, { interactive: true });

  const createdDirs = await createPlatformDirectories(cwd, finalPlatforms as Platform[]);

  // Prepare containers for file tracking
  const allAddedFiles: string[] = [];
  const allUpdatedFiles: string[] = [];

  // Phase 1: Discover and categorize files for each formula
  const categorizedByFormula = new Map<string, Awaited<ReturnType<typeof discoverAndCategorizeFiles>>>();
  for (const resolved of finalResolvedFormulas) {
    const categorized = await discoverAndCategorizeFiles(
      resolved.name,
      resolved.version,
      finalPlatforms as Platform[]
    );
    categorizedByFormula.set(resolved.name, categorized);
  }

  // Phase 2a: ID-based files (priority)
  let installedCount = 0;
  let skippedCount = 0;
  const groundzeroResults: Array<{ name: string; filesInstalled: number; filesUpdated: number; installedFiles: string[]; updatedFiles: string[]; overwritten: boolean }> = [];
  for (const resolved of finalResolvedFormulas) {
    const categorized = categorizedByFormula.get(resolved.name)!;
    if (categorized.idBasedFiles.size === 0) continue;
    try {
      const platformResult = await installFilesByIdWithMap(
        cwd,
        resolved.name,
        resolved.version,
        finalPlatforms as Platform[],
        categorized.idBasedFiles,
        options,
        conflictResult.forceOverwriteFormulas.has(resolved.name)
      );
      if (platformResult.installed > 0 || platformResult.updated > 0) {
        installedCount++;
        groundzeroResults.push({
          name: resolved.name,
          filesInstalled: platformResult.installed,
          filesUpdated: platformResult.updated,
          installedFiles: platformResult.installedFiles,
          updatedFiles: platformResult.updatedFiles,
          overwritten: platformResult.updated > 0
        });
      }
    } catch (error) {
      logger.error(`Failed ID-based install for ${resolved.name}: ${error}`);
      skippedCount++;
    }
  }

  // Phase 2b: Index.yml directories (excluding files already claimed by ID-based)
  let indexInstalledTotal = 0;
  let indexUpdatedTotal = 0;
  for (const resolved of finalResolvedFormulas) {
    const categorized = categorizedByFormula.get(resolved.name)!;
    if (categorized.indexYmlDirs.length === 0) continue;
    const indexResult = await installIndexYmlDirectories(
      cwd,
      categorized.indexYmlDirs,
      finalPlatforms as Platform[],
      options
    );
    indexInstalledTotal += indexResult.installed;
    indexUpdatedTotal += indexResult.updated;
    allAddedFiles.push(...indexResult.installedFiles);
    allUpdatedFiles.push(...indexResult.updatedFiles);
  }

  // Phase 2c: Path-based remaining files
  for (const resolved of finalResolvedFormulas) {
    const categorized = categorizedByFormula.get(resolved.name)!;
    const aiFiles = categorized.pathBasedFiles.filter(f => f.path.startsWith('ai/'));
    if (aiFiles.length === 0) continue;
    const aiResult = await installAiFilesFromList(
      cwd,
      targetDir,
      aiFiles,
      options,
      conflictResult.forceOverwriteFormulas.has(resolved.name)
    );
    if (!aiResult.skipped && aiResult.installedCount > 0) {
      installedCount++;
      const relativeInstalledFiles = aiResult.files.map(filePath => filePath.replace(cwd + '/', ''));
      const existing = groundzeroResults.find(r => r.name === resolved.name);
      if (existing) {
        existing.filesInstalled += aiResult.installedCount;
        existing.installedFiles.push(...relativeInstalledFiles);
        existing.overwritten = existing.overwritten || aiResult.overwritten;
      } else {
        groundzeroResults.push({
          name: resolved.name,
          filesInstalled: aiResult.installedCount,
          filesUpdated: 0,
          installedFiles: relativeInstalledFiles,
          updatedFiles: [],
          overwritten: aiResult.overwritten
        });
      }
    }
  }

  // Phase 2d: Root files
  const allRootFileResults = {
    installed: new Set<string>(),
    updated: new Set<string>(),
    skipped: new Set<string>()
  };
  for (const resolved of finalResolvedFormulas) {
    const categorized = categorizedByFormula.get(resolved.name)!;
    const rootFileResult = await installRootFilesFromMap(
      cwd,
      resolved.name,
      categorized.rootFiles,
      finalPlatforms as Platform[]
    );
    rootFileResult.installed.forEach(file => allRootFileResults.installed.add(file));
    rootFileResult.updated.forEach(file => allRootFileResults.updated.add(file));
    rootFileResult.skipped.forEach(file => allRootFileResults.skipped.add(file));
  }

  // Convert Sets back to arrays for compatibility
  const rootFileResultsArrays = {
    installed: Array.from(allRootFileResults.installed),
    updated: Array.from(allRootFileResults.updated),
    skipped: Array.from(allRootFileResults.skipped)
  };

  // Write local formula metadata for all successfully installed formulas
  for (const resolved of finalResolvedFormulas) {
    await writeLocalFormulaMetadata(cwd, resolved.name, resolved.formula.metadata);
  }

  // Add formula to formula.yml if it exists and we have a main formula
  if (formulaYmlExists && mainFormula) {
    await addFormulaToYml(cwd, formulaName, mainFormula.version, options.dev || false, version, true);
  }
  
  
  // Add AI files from groundzero results
  groundzeroResults.forEach(result => {
    allAddedFiles.push(...result.installedFiles);
    allUpdatedFiles.push(...result.updatedFiles);
  });


  // Calculate total groundzero files
  const totalGroundzeroFiles = groundzeroResults.reduce((sum, result) => sum + result.filesInstalled + result.filesUpdated, 0) + indexInstalledTotal + indexUpdatedTotal;
  
  // Display results
  displayInstallationResults(
    formulaName,
    finalResolvedFormulas,
    { platforms: finalPlatforms, created: createdDirs },
    options,
    mainFormula,
    allAddedFiles,
    allUpdatedFiles,
    rootFileResultsArrays,
    missingFormulas
  );
  
  return {
    success: true,
    data: {
      formulaName,
      targetDir: getAIDir(cwd),
      resolvedFormulas: finalResolvedFormulas,
      totalFormulas: finalResolvedFormulas.length,
      installed: installedCount,
      skipped: skippedCount,
      totalGroundzeroFiles
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
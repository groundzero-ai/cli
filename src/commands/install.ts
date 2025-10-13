import * as semver from 'semver';
import { Command } from 'commander';
import { InstallOptions, CommandResult, FormulaYml } from '../types/index.js';
import { ResolvedFormula } from '../core/dependency-resolver.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { gatherGlobalVersionConstraints, gatherRootVersionConstraints } from '../core/groundzero.js';
import { resolveDependencies, displayDependencyTree } from '../core/dependency-resolver.js';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, VersionConflictError, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import {
  PLATFORMS,
  CONFLICT_RESOLUTION,
  type Platform
} from '../constants/index.js';
import {
  createPlatformDirectories
} from '../core/platforms.js';
import { normalizePlatforms } from '../utils/platform-mapper.js';
import {
  getLocalFormulaYmlPath,
  getAIDir
} from '../utils/paths.js';
import { createBasicFormulaYml, addFormulaToYml } from '../utils/formula-management.js';
import {
  detectPlatforms,
  promptForPlatformSelection,
  displayInstallationSummary,
  displayInstallationResults,
  parseFormulaInput
} from '../utils/formula-installation.js';
import {
  withOperationErrorHandling,
} from '../utils/error-handling.js';
import { installFormula, processResolvedFormulas } from '../utils/install-orchestrator.js';
import { provideIdeTemplateFiles } from '../utils/file-installer.js';
import { extractFormulasFromConfig, resolveDependenciesWithOverrides } from '../utils/install-helpers.js';
import { checkAndHandleAllFormulaConflicts } from '../utils/install-conflict-handler.js';
import { parseFormulaYml } from '../utils/formula-yml.js';

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
  
  const formulasToInstall = extractFormulasFromConfig(cwdConfig);
  
  if (formulasToInstall.length === 0) {
    console.log('📦 No formulas found in formula.yml');
    console.log('\nTips:');
    console.log('• Add formulas to the "formulas" array in formula.yml');
    console.log('• Add development formulas to the "dev-formulas" array in formula.yml');
    console.log('• Use "g0 install <formula-name>" to install a specific formula');
    
    return { success: true, data: { installed: 0, skipped: 0 } };
  }
  
  console.log(`📦 Installing ${formulasToInstall.length} formulas from formula.yml:`);
  formulasToInstall.forEach(formula => {
    const prefix = formula.isDev ? '[dev] ' : '';
    const label = formula.version ? `${formula.name}@${formula.version}` : formula.name;
    console.log(`  • ${prefix}${label}`);
  });
  console.log('');
  
  // Install formulas sequentially to avoid conflicts
  let totalInstalled = 0;
  let totalSkipped = 0;
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  
  for (const formula of formulasToInstall) {
    try {
      const label = formula.version ? `${formula.name}@${formula.version}` : formula.name;
      console.log(`\n🔧 Installing ${formula.isDev ? '[dev] ' : ''}${label}...`);
      
      const installOptions: InstallOptions = { ...options, dev: formula.isDev };
      const result = await installFormulaCommand(formula.name, targetDir, installOptions, formula.version);
      
      if (result.success) {
        totalInstalled++;
        results.push({ name: formula.name, success: true });
        console.log(`✅ Successfully installed ${formula.name}`);
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
  console.log(`🔍 Dry run - showing what would be installed:\n`);
  
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
      console.log(`⏭️  Would skip ${resolved.name}@${resolved.version} (user would decline overwrite)`);
      continue;
    }
    
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.KEPT) {
      console.log(`⏭️  Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    const dryRunResult = await installFormula(resolved.name, targetDir, options, resolved.version, true);
    
    if (dryRunResult.skipped) {
      console.log(`⏭️  Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    console.log(`📁 Would install to ai${targetDir !== '.' ? '/' + targetDir : ''}: ${dryRunResult.installedCount} files`);
    
    if (dryRunResult.overwritten) {
      console.log(`  ⚠️  Would overwrite existing directory`);
    }
  }
  
  // Show formula.yml update
  if (formulaYmlExists) {
    console.log(`\n📋 Would add to .groundzero/formula.yml: ${formulaName}@${resolvedFormulas.find(f => f.isRoot)?.version}`);
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
  logger.debug(`Installing formula '${formulaName}' with dependencies to: ${getAIDir(cwd)}`, { options });
  
  await ensureRegistryDirectories();
  
  // Auto-create basic formula.yml if it doesn't exist
  await createBasicFormulaYml(cwd);

  // If platforms are specified, validate and prepare directories ahead of detection
  const specifiedPlatforms = normalizePlatforms(options.platforms);
  if (specifiedPlatforms && specifiedPlatforms.length > 0) {
    // Validate against known platforms
    const knownPlatforms = new Set<string>(Object.values(PLATFORMS));
    for (const p of specifiedPlatforms) {
      if (!knownPlatforms.has(p)) {
        return { success: false, error: `platform ${p} not found` };
      }
    }
    // Create platform directories unless dry-run
    if (!options.dryRun) {
      await createPlatformDirectories(cwd, specifiedPlatforms as Platform[]);
    }
  }
  
  // Resolve complete dependency tree first, with conflict handling and persistence
  const globalConstraints = await gatherGlobalVersionConstraints(cwd);
  let resolvedFormulas: ResolvedFormula[];
  try {
    const rootConstraints = await gatherRootVersionConstraints(cwd);
    resolvedFormulas = await resolveDependencies(
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
        const { promptVersionSelection } = await import('../utils/prompts.js');
        chosenVersion = await promptVersionSelection(details?.formulaName || name, available, 'to install');
      }

      if (!chosenVersion) {
        return { success: false, error: `Unable to resolve version for ${(error as any).details?.formulaName || name}` };
      }

      // Persist chosen version by promoting to direct dependency in main formula.yml
      await addFormulaToYml(cwd, (error as any).details?.formulaName || name, chosenVersion!, false, chosenVersion!, true);

      // Recompute constraints (now includes the persisted version in root) and re-resolve
      const updatedConstraints = await gatherGlobalVersionConstraints(cwd);
      const overrideResolvedFormulas = await resolveDependenciesWithOverrides(
        formulaName,
        cwd,
        [],
        updatedConstraints,
        version
      );
      resolvedFormulas = overrideResolvedFormulas;
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
    console.log(`⏭️  Installation cancelled by user`);
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

  // Detect platforms and create directories (prefer specified if provided)
  let finalPlatforms = await detectPlatforms(cwd);
  if (specifiedPlatforms && specifiedPlatforms.length > 0) {
    finalPlatforms = specifiedPlatforms;
  } else if (finalPlatforms.length === 0) {
    finalPlatforms = await promptForPlatformSelection();
  }

  const createdDirs = await createPlatformDirectories(cwd, finalPlatforms as Platform[]);

  // Now process resolved formulas with platform information for ID-based installation
  const { installedCount, skippedCount, groundzeroResults } = await processResolvedFormulas(
    finalResolvedFormulas, 
    targetDir, 
    options, 
    conflictResult.forceOverwriteFormulas, 
    finalPlatforms as Platform[]
  );

  // Install root files from registry for all formulas in dependency tree
  const { installRootFiles } = await import('../utils/root-file-installer.js');
  const allRootFileResults = { installed: [] as string[], updated: [] as string[], skipped: [] as string[] };
  
  for (const resolved of finalResolvedFormulas) {
    const rootFileResult = await installRootFiles(
      cwd,
      resolved.name,
      resolved.version,
      finalPlatforms as Platform[]
    );
    
    // Aggregate results
    allRootFileResults.installed.push(...rootFileResult.installed);
    allRootFileResults.updated.push(...rootFileResult.updated);
    allRootFileResults.skipped.push(...rootFileResult.skipped);
  }

  // Add formula to formula.yml if it exists and we have a main formula
  if (formulaYmlExists && mainFormula) {
    await addFormulaToYml(cwd, formulaName, mainFormula.version, options.dev || false, version, true);
  }
  
  // Provide IDE-specific template files (use specified/detected platforms)
  const ideTemplateResult = await provideIdeTemplateFiles(cwd, finalPlatforms, options);
  
  // Collect all added and updated files
  const allAddedFiles: string[] = [];
  const allUpdatedFiles: string[] = [];

  // Add AI files from groundzero results
  groundzeroResults.forEach(result => {
    allAddedFiles.push(...result.installedFiles);
    allUpdatedFiles.push(...result.updatedFiles);
  });

  // Add IDE template files (all are newly added)
  allAddedFiles.push(...ideTemplateResult.filesAdded);

  // Calculate total groundzero files
  const totalGroundzeroFiles = groundzeroResults.reduce((sum, result) => sum + result.filesInstalled + result.filesUpdated, 0);
  
  // Display results
  displayInstallationResults(
    formulaName,
    finalResolvedFormulas,
    { platforms: finalPlatforms, created: createdDirs },
    ideTemplateResult,
    options,
    mainFormula,
    allAddedFiles,
    allUpdatedFiles,
    allRootFileResults
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
    .description('Install formulas from local registry to codebase at cwd. Supports versioning with formula@version syntax.')
    .argument('[formula-name]', 'name of the formula to install (optional - installs all from formula.yml if not specified). Supports formula@version syntax.')
    .argument('[target-dir]', 'target directory relative to cwd/ai for /ai files only (defaults to ai root)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--force', 'overwrite existing files')
    .option('--dev', 'add formula to dev-formulas instead of formulas')
    .option('--platforms <platforms...>', 'prepare specific platforms (e.g., cursor claudecode opencode)')
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
import { Command } from 'commander';
import { join, relative } from 'path';
import { UninstallOptions, CommandResult } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { discoverFiles } from '../utils/file-discovery.js';
import { type PlatformName } from '../core/platforms.js';
import { detectPlatforms } from '../utils/formula-installation.js';
import { cleanupPlatformFiles as cleanupPlatformFilesForSingle } from '../utils/platform-utils.js';
import { buildDependencyTree, findDanglingDependencies } from '../core/dependency-resolver.js';
import { cleanupObsoleteResolutions } from '../core/groundzero.js';
import { exists, remove, removeEmptyDirectories } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import {
  PLATFORM_DIRS,
  FILE_PATTERNS,
  DEPENDENCY_ARRAYS,
  GLOBAL_PLATFORM_FILES,
} from '../constants/index.js';
import { getLocalFormulaYmlPath, getAIDir, getLocalFormulasDir, getLocalFormulaDir } from '../utils/paths.js';


/**
 * Clean up platform-specific files for a formula across all detected platforms
 * - Iterates detected platforms
 * - Traverses supported subdirs (rules/commands/agents and platform-specific rules)
 * - Deletes files whose frontmatter formula.name matches target
 * - Preserves global groundzero files defined in GLOBAL_PLATFORM_FILES
 */
async function cleanupPlatformFiles(
  targetDir: string,
  formulaName: string,
  options: UninstallOptions
): Promise<Record<string, string[]>> {
  const cwd = targetDir;
  const platforms = await detectPlatforms(cwd);
  const cleanedByPlatform: Record<string, string[]> = {};

  // Process each detected platform using the shared single-platform cleanup
  await Promise.all(platforms.map(async (platform) => {
    const result = await cleanupPlatformFilesForSingle(
      cwd,
      platform as PlatformName,
      formulaName,
      { dryRun: options.dryRun }
    );
    cleanedByPlatform[platform] = result.files.map(p => relative(cwd, p).replace(/\\/g, '/'));
  }));

  return cleanedByPlatform;
}

/**
 * Get protected formulas from cwd formula.yml
 */
async function getProtectedFormulas(targetDir: string): Promise<Set<string>> {
  const protectedFormulas = new Set<string>();
  
  const formulaYmlPath = getLocalFormulaYmlPath(targetDir);
  if (!(await exists(formulaYmlPath))) return protectedFormulas;
  
  try {
    const config = await parseFormulaYml(formulaYmlPath);
    
    // Add all formulas and dev-formulas to protected set
    const allDeps = [
      ...(config.formulas || []),
      ...(config['dev-formulas'] || [])
    ];
    
    allDeps.forEach(dep => protectedFormulas.add(dep.name));
    logger.debug(`Protected formulas: ${Array.from(protectedFormulas).join(', ')}`);
  } catch (error) {
    logger.warn(`Failed to parse formula.yml for protected formulas: ${error}`);
  }
  
  return protectedFormulas;
}

/**
 * Remove formula from formula.yml or .formula.yml file
 */
async function removeFormulaFromYml(targetDir: string, formulaName: string): Promise<boolean> {
  // Check for .groundzero/formula.yml first, then .formula.yml (legacy)
  const configPaths = [
    getLocalFormulaYmlPath(targetDir),
    join(targetDir, FILE_PATTERNS.HIDDEN_FORMULA_YML)
  ];
  
  let configPath: string | null = null;
  for (const path of configPaths) {
    if (await exists(path)) {
      configPath = path;
      break;
    }
  }
  
  if (!configPath) {
    logger.warn('No formula.yml or .formula.yml file found to update');
    return false;
  }
  
  try {
    const config = await parseFormulaYml(configPath);
    let removed = false;
    
    // Remove from both formulas and dev-formulas arrays
    const sections = [DEPENDENCY_ARRAYS.FORMULAS, DEPENDENCY_ARRAYS.DEV_FORMULAS] as const;
    for (const section of sections) {
      if (config[section]) {
        const initialLength = config[section]!.length;
        config[section] = config[section]!.filter(dep => dep.name !== formulaName);
        if (config[section]!.length < initialLength) {
          removed = true;
          logger.info(`Removed ${formulaName} from ${section}`);
        }
      }
    }
    
    if (removed) {
      await writeFormulaYml(configPath, config);
      return true;
    } else {
      logger.warn(`Formula ${formulaName} not found in dependencies`);
      return false;
    }
  } catch (error) {
    logger.error(`Failed to update formula.yml: ${error}`);
    return false;
  }
}

/**
 * Display dry run information
 */
async function displayDryRunInfo(
  formulaName: string,
  targetDir: string,
  options: UninstallOptions,
  danglingDependencies: Set<string>,
  groundzeroPath: string,
  aiFilesToRemove: string[],
  formulasToRemove: string[]
): Promise<void> {
  console.log(`🔍 Dry run - showing what would be uninstalled:\n`);

  console.log(`📦 Formulas to remove: ${formulasToRemove.length}`);
  console.log(`├── Main: ${formulaName}`);
  if (danglingDependencies.size > 0) {
    for (const dep of danglingDependencies) {
      console.log(`├── Dependency: ${dep}`);
    }
  }

  if (aiFilesToRemove.length > 0) {
    console.log(`\n🗑️  AI files to remove (${aiFilesToRemove.length}):`);
    const preview = aiFilesToRemove.slice(0, 10);
    for (const f of preview) {
      console.log(`├── ${f}`);
    }
    if (aiFilesToRemove.length > preview.length) {
      console.log(`… and ${aiFilesToRemove.length - preview.length} more`);
    }
  } else {
    console.log(`\n🗑️  AI files to remove: none`);
  }

  // Check formula.yml files that would be removed
  const formulasDir = getLocalFormulasDir(targetDir);
  const formulaYmlFilesToRemove: string[] = [];
  for (const formula of formulasToRemove) {
    const formulaDir = getLocalFormulaDir(targetDir, formula);
    const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
    if (await exists(formulaYmlPath)) {
      formulaYmlFilesToRemove.push(formula);
    }
  }

  if (formulaYmlFilesToRemove.length > 0) {
    console.log(`\n📄 Formula metadata to remove (${formulaYmlFilesToRemove.length}):`);
    for (const formula of formulaYmlFilesToRemove) {
      console.log(`├── ${formula}`);
    }
  } else {
    console.log(`\n📄 Formula metadata to remove: none`);
  }
  
  console.log('');
  
  // Check platform files that would be cleaned up for all formulas
  const dryRunPlatformCleanupPromises = formulasToRemove.map(formula =>
    cleanupPlatformFiles(targetDir, formula, { ...options, dryRun: true })
  );
  const dryRunPlatformCleanupResults = await Promise.all(dryRunPlatformCleanupPromises);

  // Aggregate platform cleanup results across all formulas
  const platformCleanup: Record<string, string[]> = {};
  for (const result of dryRunPlatformCleanupResults) {
    for (const [platform, files] of Object.entries(result)) {
      if (!platformCleanup[platform]) {
        platformCleanup[platform] = [];
      }
      platformCleanup[platform].push(...files);
    }
  }
  displayPlatformCleanupInfo(platformCleanup);

  // Check formula.yml updates
  const configPaths = [
    getLocalFormulaYmlPath(targetDir),
    join(targetDir, FILE_PATTERNS.HIDDEN_FORMULA_YML)
  ];

  const hasConfigFile = await Promise.all(configPaths.map(path => exists(path)));
  if (hasConfigFile.some(exists => exists)) {
    console.log(`📋 Would attempt to remove formulas from formula dependencies:`);
    for (const formula of formulasToRemove) {
      console.log(`├── ${formula}`);
    }
  } else {
    console.log('📋 No formula.yml file to update');
  }

  console.log(`🧹 Would clean up any obsolete dependency resolution pins`);
}

/**
 * Display platform cleanup information
 */
function displayPlatformCleanupInfo(platformCleanup: Record<string, string[]>): void {
  const platforms = Object.keys(platformCleanup);
  const any = platforms.some(p => (platformCleanup[p] || []).length > 0);
  if (any) {
    console.log('Platform files that would be cleaned up:');
    for (const p of platforms) {
      const files = platformCleanup[p];
      if (files && files.length > 0) {
        console.log(`├── ${p}: ${files.join(', ')}`);
      }
    }
  } else {
    console.log('Platform files: No formula-specific platform files to clean up');
    const preserved = Object.values(GLOBAL_PLATFORM_FILES);
    if (preserved.length > 0) {
      console.log('├── Preserved global files:');
      for (const f of preserved) console.log(`   ├── ${f}`);
    }
  }
}

/**
 * Display uninstall success information
 */
function displayUninstallSuccess(
  formulaName: string,
  targetDir: string,
  options: UninstallOptions,
  danglingDependencies: Set<string>,
  removedAiFiles: string[],
  ymlRemovalResults: Record<string, boolean>,
  platformCleanup: Record<string, string[]>,
  cleanedResolutions: string[]
): void {
  console.log(`✓ Formula '${formulaName}' uninstalled successfully`);
  console.log(`📁 Target directory: ${targetDir}`);
  
  const aiRemovalCount = removedAiFiles.length;
  console.log(`🗑️  Removed AI files: ${aiRemovalCount}`);
  if (aiRemovalCount > 0) {
    // Show up to first 10 entries to keep output concise
    const preview = removedAiFiles.slice(0, 10);
    for (const f of preview) {
      console.log(`   ├── ${f}`);
    }
    if (removedAiFiles.length > preview.length) {
      console.log(`   … and ${removedAiFiles.length - preview.length} more`);
    }
  }
  
  // Report formula.yml updates
  const successfulRemovals = Object.entries(ymlRemovalResults).filter(([, success]) => success);
  const failedRemovals = Object.entries(ymlRemovalResults).filter(([, success]) => !success);

  if (successfulRemovals.length > 0) {
    console.log(`📋 Removed from formula dependencies:`);
    for (const [formula] of successfulRemovals) {
      console.log(`   ├── ${formula}`);
    }
  }

  if (failedRemovals.length > 0) {
    console.log(`⚠️  Could not update formula.yml for:`);
    for (const [formula] of failedRemovals) {
      console.log(`   ├── ${formula} (not found or not listed)`);
    }
  }

  if (cleanedResolutions.length > 0) {
    console.log(`🧹 Cleaned up obsolete resolution pins: ${cleanedResolutions.length}`);
    for (const dep of cleanedResolutions) {
      console.log(`   ├── ${dep}`);
    }
  }

  // Report platform cleanup
  const platforms = Object.keys(platformCleanup);
  const any = platforms.some(p => (platformCleanup[p] || []).length > 0);
  if (any) {
    console.log(`🧹 Cleaned up platform files:`);
    for (const p of platforms) {
      const files = platformCleanup[p];
      if (files && files.length > 0) {
        console.log(`   ├── ${p}: ${files.join(', ')}`);
      }
    }
  } else {
    console.log(`🧹 Platform files: No formula-specific files to clean up`);
    const preserved = Object.values(GLOBAL_PLATFORM_FILES);
    if (preserved.length > 0) {
      for (const f of preserved) console.log(`   ├── Preserved: ${f}`);
    }
  }
}

/**
 * Uninstall formula command implementation with recursive dependency resolution
 */
async function uninstallFormulaCommand(
  formulaName: string,
  targetDir: string,
  options: UninstallOptions
): Promise<CommandResult> {
  logger.info(`Uninstalling formula '${formulaName}' from: ${targetDir}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  const cwd = process.cwd();
  const aiRootPath = getAIDir(cwd);
  const groundzeroPath = targetDir && targetDir !== '.'
    ? join(aiRootPath, targetDir.startsWith('/') ? targetDir.slice(1) : targetDir)
    : aiRootPath;
  
  // Check if ai directory exists
  if (!(await exists(groundzeroPath))) {
    console.log(`❌ Formula '${formulaName}' not found`);
    console.log(`AI directory not found in: ${targetDir}`);
    return {
      success: false,
      error: 'Formula not found'
    };
  }

  // Helper now available in fs utils: removeEmptyDirectories
  
  // Determine what formulas to remove
  let formulasToRemove = [formulaName];
  let danglingDependencies: Set<string> = new Set();
  
  if (options.recursive) {
    // Build dependency tree and find dangling dependencies
    const protectedFormulas = await getProtectedFormulas(cwd);
    const dependencyTree = await buildDependencyTree(groundzeroPath, protectedFormulas);
    danglingDependencies = await findDanglingDependencies(formulaName, dependencyTree);
    
    formulasToRemove = [formulaName, ...Array.from(danglingDependencies)];
    
    if (danglingDependencies.size > 0) {
      console.log(`\n📦 Recursive uninstall mode - found ${danglingDependencies.size} dangling dependencies:`);
      for (const dep of danglingDependencies) {
        console.log(`├── ${dep}`);
      }
      console.log(`\n🔍 Total formulas to remove: ${formulasToRemove.length}`);
    } else {
      console.log(`\n📦 Recursive uninstall mode - no dangling dependencies found`);
    }
  }
  
  // Compute AI files to remove for main + dependencies
  const aiFilesToRemoveSets = await Promise.all(formulasToRemove.map(async (name) => {
    const discovered = await discoverFiles(
      groundzeroPath,
      name,
      'ai' as PlatformName,
      PLATFORM_DIRS.AI,
      [FILE_PATTERNS.MD_FILES],
      'platform'
    );
    return discovered.map(d => d.fullPath);
  }));
  const aiFilesToRemove = Array.from(new Set(aiFilesToRemoveSets.flat()));

  // If no ai files found for main formula and not recursive, treat as not found
  if (!options.recursive) {
    if (aiFilesToRemove.length === 0) {
      console.log(`❌ Formula '${formulaName}' not found`);
      console.log(`No matching AI files found in ai directory`);
      return {
        success: false,
        error: 'Formula not found'
      };
    }
  }

  // Dry run mode
  if (options.dryRun) {
    const relAiFiles = aiFilesToRemove.map(p => relative(groundzeroPath, p));
    await displayDryRunInfo(formulaName, targetDir, options, danglingDependencies, groundzeroPath, relAiFiles, formulasToRemove);
    
    const platformCleanup = await cleanupPlatformFiles(cwd, formulaName, { ...options, dryRun: true });
    return {
      success: true,
      data: {
        dryRun: true,
        formulaName,
        targetDir,
        aiFiles: relAiFiles,
        recursive: options.recursive,
        danglingDependencies: Array.from(danglingDependencies),
        totalToRemove: formulasToRemove.length,
        platformCleanup
      }
    };
  }
  
  // Perform actual uninstallation
  try {
    const removedAiFiles: string[] = [];
    
    // Remove AI files (main + dangling dependencies)
    for (const filePath of aiFilesToRemove) {
      await remove(filePath);
      removedAiFiles.push(relative(groundzeroPath, filePath));
      logger.debug(`Removed AI file: ${filePath}`);
    }

    // Remove empty directories under ai target path
    await removeEmptyDirectories(groundzeroPath);

    // Remove formula.yml files and directories for all formulas being removed
    const formulasDir = getLocalFormulasDir(cwd);
    for (const formula of formulasToRemove) {
      const formulaDir = getLocalFormulaDir(cwd, formula);
      const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

      // Remove the formula.yml file if it exists
      if (await exists(formulaYmlPath)) {
        await remove(formulaYmlPath);
        logger.debug(`Removed formula.yml file: ${formulaYmlPath}`);
      }

      // Remove the formula directory if it exists
      if (await exists(formulaDir)) {
        await remove(formulaDir);
        logger.debug(`Removed formula directory: ${formulaDir}`);
      }
    }

    // Remove empty directories under .groundzero/formulas
    if (await exists(formulasDir)) {
      await removeEmptyDirectories(formulasDir);
    }

    // Clean up platform-specific files for all formulas being removed
    const platformCleanupPromises = formulasToRemove.map(formula =>
      cleanupPlatformFiles(cwd, formula, options)
    );
    const platformCleanupResults = await Promise.all(platformCleanupPromises);

    // Aggregate platform cleanup results across all formulas
    const platformCleanup: Record<string, string[]> = {};
    for (const result of platformCleanupResults) {
      for (const [platform, files] of Object.entries(result)) {
        if (!platformCleanup[platform]) {
          platformCleanup[platform] = [];
        }
        platformCleanup[platform].push(...files);
      }
    }
    
    // Remove all formulas being uninstalled from formula.yml or .formula.yml
    const ymlRemovalResults: Record<string, boolean> = {};
    for (const formula of formulasToRemove) {
      ymlRemovalResults[formula] = await removeFormulaFromYml(cwd, formula);
    }
    const removedFromYml = ymlRemovalResults[formulaName];

    // Clean up obsolete dependency resolutions
    const { removed: cleanedResolutions } = await cleanupObsoleteResolutions(cwd);

    // Success output
    displayUninstallSuccess(formulaName, targetDir, options, danglingDependencies, removedAiFiles, ymlRemovalResults, platformCleanup, cleanedResolutions);

    return {
      success: true,
      data: {
        formulaName,
        targetDir,
        aiFiles: removedAiFiles,
        ymlRemovalResults,
        recursive: options.recursive,
        danglingDependencies: Array.from(danglingDependencies),
        totalRemoved: removedAiFiles.length,
        platformCleanup,
        cleanedResolutions
      }
    };
  } catch (error) {
    logger.error(`Failed to uninstall formula '${formulaName}': ${error}`);
    throw new ValidationError(`Failed to uninstall formula: ${error}`);
  }
}

/**
 * Setup the uninstall command
 */
export function setupUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Remove a formula from the ai directory and update dependencies')
    .argument('<formula-name>', 'name of the formula to uninstall')
    .argument('[target-dir]', 'target directory (defaults to current directory)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--recursive', 'recursively remove dangling dependencies (formulas not depended upon by any remaining formulas, excluding those listed in cwd formula.yml)')
    .action(withErrorHandling(async (formulaName: string, targetDir: string, options: UninstallOptions) => {
      const result = await uninstallFormulaCommand(formulaName, targetDir, options);
      if (!result.success && result.error !== 'Formula not found') {
        throw new Error(result.error || 'Uninstall operation failed');
      }
    }));
}

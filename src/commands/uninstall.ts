import { Command } from 'commander';
import { join } from 'path';
import { readdir } from 'fs/promises';
import { UninstallOptions, CommandResult } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml, parseMarkdownFrontmatter } from '../utils/formula-yml.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { findFormulaDirectory } from '../core/groundzero.js';
import { buildDependencyTree, findDanglingDependencies } from '../core/dependency-resolver.js';
import { exists, remove, readTextFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';

// Consolidated constants
const CONSTANTS = {
  PLATFORM_DIRS: {
    CURSOR: '.cursor',
    CLAUDE: '.claude',
    AI: 'ai'
  },
  FILE_PATTERNS: {
    FORMULA_YML: 'formula.yml',
    HIDDEN_FORMULA_YML: '.formula.yml',
    GROUNDZERO_MDC: 'groundzero.mdc',
    GROUNDZERO_MD: 'groundzero.md'
  },
  GLOBAL_FILES: {
    CURSOR_GROUNDZERO: '.cursor/rules/groundzero.mdc',
    CLAUDE_GROUNDZERO: '.claude/groundzero.md'
  }
} as const;


/**
 * Clean up platform-specific files for a formula
 * Note: Global platform files (groundzero.mdc, groundzero.md) are preserved as they're shared across formulas
 */
async function cleanupPlatformFiles(
  targetDir: string,
  formulaName: string,
  options: UninstallOptions
): Promise<{ cursorFiles: string[]; claudeFiles: string[] }> {
  const cleaned = { cursorFiles: [] as string[], claudeFiles: [] as string[] };
  
  // Process both platforms in parallel
  const platformTasks = [
    processPlatform(targetDir, CONSTANTS.PLATFORM_DIRS.CURSOR, formulaName, options, cleaned.cursorFiles),
    processPlatform(targetDir, CONSTANTS.PLATFORM_DIRS.CLAUDE, formulaName, options, cleaned.claudeFiles)
  ];
  
  await Promise.all(platformTasks);
  return cleaned;
}

/**
 * Process a single platform directory
 */
async function processPlatform(
  targetDir: string,
  platformDir: string,
  formulaName: string,
  options: UninstallOptions,
  cleanedFiles: string[]
): Promise<void> {
  const fullPath = join(targetDir, platformDir);
  if (!(await exists(fullPath))) return;
  
  logger.debug(`Checking for formula-specific ${platformDir} files for: ${formulaName}`);
  
  const formulaFiles = await findFormulaSpecificFiles(fullPath, formulaName);
  for (const filePath of formulaFiles) {
    if (!options.keepData) {
      await remove(filePath);
      const relativePath = filePath.replace(fullPath + '/', '');
      cleanedFiles.push(`${platformDir}/${relativePath}`);
      logger.info(`Removed formula-specific ${platformDir} file: ${relativePath}`);
    }
  }
  
  const globalFile = platformDir === CONSTANTS.PLATFORM_DIRS.CURSOR 
    ? CONSTANTS.GLOBAL_FILES.CURSOR_GROUNDZERO 
    : CONSTANTS.GLOBAL_FILES.CLAUDE_GROUNDZERO;
  logger.debug(`Preserved global ${platformDir} file: ${globalFile}`);
}

/**
 * Find formula-specific files in a platform directory based on YAML frontmatter
 * This function looks for markdown files that have frontmatter with the specific formula name
 */
async function findFormulaSpecificFiles(platformDir: string, formulaName: string): Promise<string[]> {
  const formulaFiles: string[] = [];
  
  try {
    const findFiles = async (dir: string, basePath: string = ''): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      
      // Process entries in parallel for better performance
      const tasks = entries.map(async (entry) => {
        const fullPath = join(dir, entry.name);
        const relativePath = basePath ? join(basePath, entry.name) : entry.name;
        
        if (entry.isDirectory()) {
          await findFiles(fullPath, relativePath);
        } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdc'))) {
          // Skip global files that should be preserved
          const isGlobalFile = (
            relativePath === `rules/${CONSTANTS.FILE_PATTERNS.GROUNDZERO_MDC}` ||
            relativePath === CONSTANTS.FILE_PATTERNS.GROUNDZERO_MD
          );
          
          if (!isGlobalFile) {
            try {
              const content = await readTextFile(fullPath);
              const frontmatter = parseMarkdownFrontmatter(content);
              
              if (frontmatter?.formula?.name === formulaName) {
                formulaFiles.push(fullPath);
                logger.debug(`Found formula-specific file: ${relativePath} (frontmatter: formula.name = ${formulaName})`);
              }
            } catch (error) {
              logger.warn(`Failed to read or parse frontmatter from ${relativePath}: ${error}`);
            }
          }
        }
      });
      
      await Promise.all(tasks);
    };
    
    await findFiles(platformDir);
  } catch (error) {
    logger.warn(`Failed to scan platform directory ${platformDir}: ${error}`);
  }
  
  return formulaFiles;
}

/**
 * Get protected formulas from cwd formula.yml
 */
async function getProtectedFormulas(targetDir: string): Promise<Set<string>> {
  const protectedFormulas = new Set<string>();
  
  const formulaYmlPath = join(targetDir, CONSTANTS.FILE_PATTERNS.FORMULA_YML);
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
  // Check for formula.yml first, then .formula.yml
  const configPaths = [
    join(targetDir, CONSTANTS.FILE_PATTERNS.FORMULA_YML),
    join(targetDir, CONSTANTS.FILE_PATTERNS.HIDDEN_FORMULA_YML)
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
    const sections = ['formulas', 'dev-formulas'] as const;
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
  formulaDirectoryPath: string,
  options: UninstallOptions,
  danglingDependencies: Set<string>,
  groundzeroPath: string
): Promise<void> {
  console.log(`🔍 Dry run - showing what would be uninstalled:\n`);
  
  console.log(`Main formula: ${formulaName}`);
  console.log(`Directory to remove: ${formulaDirectoryPath}`);
  
  if (options.recursive && danglingDependencies.size > 0) {
    console.log(`\nDangling dependencies to remove:`);
    for (const dep of danglingDependencies) {
      const depPath = await findFormulaDirectory(groundzeroPath, dep);
      if (depPath) {
        console.log(`├── ${dep} (${depPath})`);
      }
    }
  }
  
  console.log('');
  
  // Check platform files that would be cleaned up
  const platformCleanup = await cleanupPlatformFiles(targetDir, formulaName, { ...options, dryRun: true });
  displayPlatformCleanupInfo(platformCleanup);
  
  // Check if formula would be removed from formula.yml
  const configPaths = [
    join(targetDir, CONSTANTS.FILE_PATTERNS.FORMULA_YML),
    join(targetDir, CONSTANTS.FILE_PATTERNS.HIDDEN_FORMULA_YML)
  ];
  
  const hasConfigFile = await Promise.all(configPaths.map(path => exists(path)));
  if (hasConfigFile.some(exists => exists)) {
    console.log(`Would remove ${formulaName} from formula dependencies`);
  } else {
    console.log('No formula.yml file to update');
  }
  
  if (options.keepData) {
    console.log('💾 Keep data mode - this would preserve data files during uninstall');
  }
}

/**
 * Display platform cleanup information
 */
function displayPlatformCleanupInfo(platformCleanup: { cursorFiles: string[]; claudeFiles: string[] }): void {
  if (platformCleanup.cursorFiles.length > 0 || platformCleanup.claudeFiles.length > 0) {
    console.log('Platform files that would be cleaned up:');
    if (platformCleanup.cursorFiles.length > 0) {
      console.log(`├── Cursor files: ${platformCleanup.cursorFiles.join(', ')}`);
    }
    if (platformCleanup.claudeFiles.length > 0) {
      console.log(`├── Claude files: ${platformCleanup.claudeFiles.join(', ')}`);
    }
  } else {
    console.log('Platform files: No formula-specific platform files to clean up');
    console.log(`├── Preserved global Cursor file: ${CONSTANTS.GLOBAL_FILES.CURSOR_GROUNDZERO}`);
    console.log(`├── Preserved global Claude file: ${CONSTANTS.GLOBAL_FILES.CLAUDE_GROUNDZERO}`);
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
  removedDirectories: string[],
  removedFromYml: boolean,
  platformCleanup: { cursorFiles: string[]; claudeFiles: string[] }
): void {
  console.log(`✓ Formula '${formulaName}' uninstalled successfully`);
  console.log(`📁 Target directory: ${targetDir}`);
  
  if (options.recursive && danglingDependencies.size > 0) {
    console.log(`🗑️  Removed main formula: ${CONSTANTS.PLATFORM_DIRS.AI}/${formulaName}`);
    console.log(`🗑️  Removed ${danglingDependencies.size} dangling dependencies:`);
    for (const dep of danglingDependencies) {
      if (removedDirectories.includes(dep)) {
        console.log(`   ├── ${CONSTANTS.PLATFORM_DIRS.AI}/${dep}`);
      }
    }
    console.log(`📊 Total directories removed: ${removedDirectories.length}`);
  } else {
    console.log(`🗑️  Removed directory: ${CONSTANTS.PLATFORM_DIRS.AI}/${formulaName}`);
  }
  
  if (removedFromYml) {
    console.log(`📋 Removed from formula dependencies`);
  } else {
    console.log(`⚠️  Could not update formula.yml (not found or formula not listed)`);
  }
  
  // Report platform cleanup
  if (platformCleanup.cursorFiles.length > 0 || platformCleanup.claudeFiles.length > 0) {
    console.log(`🧹 Cleaned up platform files:`);
    if (platformCleanup.cursorFiles.length > 0) {
      console.log(`   ├── Cursor: ${platformCleanup.cursorFiles.join(', ')}`);
    }
    if (platformCleanup.claudeFiles.length > 0) {
      console.log(`   ├── Claude: ${platformCleanup.claudeFiles.join(', ')}`);
    }
  } else {
    console.log(`🧹 Platform files: No formula-specific files to clean up`);
    console.log(`   ├── Preserved global Cursor file: ${CONSTANTS.GLOBAL_FILES.CURSOR_GROUNDZERO}`);
    console.log(`   ├── Preserved global Claude file: ${CONSTANTS.GLOBAL_FILES.CLAUDE_GROUNDZERO}`);
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
  
  const groundzeroPath = join(targetDir, CONSTANTS.PLATFORM_DIRS.AI);
  
  // Check if ai directory exists
  if (!(await exists(groundzeroPath))) {
    console.log(`❌ Formula '${formulaName}' not found`);
    console.log(`AI directory not found in: ${targetDir}`);
    return {
      success: false,
      error: 'Formula not found'
    };
  }
  
  // Find the formula directory in ai
  const formulaDirectoryPath = await findFormulaDirectory(groundzeroPath, formulaName);
  
  if (!formulaDirectoryPath) {
    console.log(`❌ Formula '${formulaName}' not found`);
    console.log(`No matching formula found in ai directory`);
    return {
      success: false,
      error: 'Formula not found'
    };
  }
  
  // Determine what formulas to remove
  let formulasToRemove = [formulaName];
  let danglingDependencies: Set<string> = new Set();
  
  if (options.recursive) {
    // Build dependency tree and find dangling dependencies
    const protectedFormulas = await getProtectedFormulas(targetDir);
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
  
  // Dry run mode
  if (options.dryRun) {
    await displayDryRunInfo(formulaName, targetDir, formulaDirectoryPath, options, danglingDependencies, groundzeroPath);
    
    const platformCleanup = await cleanupPlatformFiles(targetDir, formulaName, { ...options, dryRun: true });
    return {
      success: true,
      data: {
        dryRun: true,
        formulaName,
        targetDir,
        formulaDirectory: formulaDirectoryPath,
        recursive: options.recursive,
        danglingDependencies: Array.from(danglingDependencies),
        totalToRemove: formulasToRemove.length,
        platformCleanup
      }
    };
  }
  
  // Perform actual uninstallation
  try {
    const removedDirectories: string[] = [];
    
    // Remove all formulas (main + dangling dependencies)
    for (const formulaToRemove of formulasToRemove) {
      const formulaDirPath = await findFormulaDirectory(groundzeroPath, formulaToRemove);
      if (formulaDirPath) {
        await remove(formulaDirPath);
        removedDirectories.push(formulaToRemove);
        logger.info(`Removed formula directory: ${formulaDirPath}`);
      } else {
        logger.warn(`Formula directory not found for: ${formulaToRemove}`);
      }
    }
    
    // Clean up platform-specific files for the main formula
    const platformCleanup = await cleanupPlatformFiles(targetDir, formulaName, options);
    
    // Remove main formula from formula.yml or .formula.yml
    const removedFromYml = await removeFormulaFromYml(targetDir, formulaName);
    
    // Success output
    displayUninstallSuccess(formulaName, targetDir, options, danglingDependencies, removedDirectories, removedFromYml, platformCleanup);
    
    return {
      success: true,
      data: {
        formulaName,
        targetDir,
        formulaDirectory: formulaDirectoryPath,
        removedFromYml,
        recursive: options.recursive,
        danglingDependencies: Array.from(danglingDependencies),
        removedDirectories,
        totalRemoved: removedDirectories.length,
        platformCleanup
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
    .option('--keep-data', 'keep data files when removing')
    .option('--recursive', 'recursively remove dangling dependencies (formulas not depended upon by any remaining formulas, excluding those listed in cwd formula.yml)')
    .action(withErrorHandling(async (formulaName: string, targetDir: string, options: UninstallOptions) => {
      const result = await uninstallFormulaCommand(formulaName, targetDir, options);
      if (!result.success && result.error !== 'Formula not found') {
        throw new Error(result.error || 'Uninstall operation failed');
      }
    }));
}

import { Command } from 'commander';
import { join } from 'path';
import { UninstallOptions, CommandResult } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { findFormulaDirectory } from '../core/groundzero.js';
import { buildDependencyTree, findDanglingDependencies } from '../core/dependency-resolver.js';
import { exists, remove } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';


/**
 * Get protected formulas from cwd formula.yml
 */
async function getProtectedFormulas(targetDir: string): Promise<Set<string>> {
  const protectedFormulas = new Set<string>();
  
  const formulaYmlPath = join(targetDir, 'formula.yml');
  if (await exists(formulaYmlPath)) {
    try {
      const config = await parseFormulaYml(formulaYmlPath);
      
      // Add all formulas and dev-formulas to protected set
      const allDeps = [
        ...(config.formulas || []),
        ...(config['dev-formulas'] || [])
      ];
      
      for (const dep of allDeps) {
        protectedFormulas.add(dep.name);
      }
      
      logger.debug(`Protected formulas: ${Array.from(protectedFormulas).join(', ')}`);
    } catch (error) {
      logger.warn(`Failed to parse formula.yml for protected formulas: ${error}`);
    }
  }
  
  return protectedFormulas;
}

/**
 * Remove formula from formula.yml or .formula.yml file
 */
async function removeFormulaFromYml(targetDir: string, formulaName: string): Promise<boolean> {
  // Check for formula.yml first, then .formula.yml
  const formulaYmlPath = join(targetDir, 'formula.yml');
  const hiddenFormulaYmlPath = join(targetDir, '.formula.yml');
  
  let configPath: string | null = null;
  if (await exists(formulaYmlPath)) {
    configPath = formulaYmlPath;
  } else if (await exists(hiddenFormulaYmlPath)) {
    configPath = hiddenFormulaYmlPath;
  }
  
  if (!configPath) {
    logger.warn('No formula.yml or .formula.yml file found to update');
    return false;
  }
  
  try {
    const config = await parseFormulaYml(configPath);
    let removed = false;
    
    // Remove from formulas array
    if (config.formulas) {
      const initialLength = config.formulas.length;
      config.formulas = config.formulas.filter(dep => dep.name !== formulaName);
      if (config.formulas.length < initialLength) {
        removed = true;
        logger.info(`Removed ${formulaName} from formulas`);
      }
    }
    
    // Remove from dev-formulas array
    if (config['dev-formulas']) {
      const initialLength = config['dev-formulas'].length;
      config['dev-formulas'] = config['dev-formulas'].filter(dep => dep.name !== formulaName);
      if (config['dev-formulas'].length < initialLength) {
        removed = true;
        logger.info(`Removed ${formulaName} from dev-formulas`);
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
  
  const groundzeroPath = join(targetDir, 'ai');
  
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
    
    // Check if formula would be removed from formula.yml
    const formulaYmlPath = join(targetDir, 'formula.yml');
    const hiddenFormulaYmlPath = join(targetDir, '.formula.yml');
    
    if (await exists(formulaYmlPath) || await exists(hiddenFormulaYmlPath)) {
      console.log(`Would remove ${formulaName} from formula dependencies`);
    } else {
      console.log('No formula.yml file to update');
    }
    
    if (options.keepData) {
      console.log('💾 Keep data mode - this would preserve data files during uninstall');
    }
    
    return {
      success: true,
      data: {
        dryRun: true,
        formulaName,
        targetDir,
        formulaDirectory: formulaDirectoryPath,
        recursive: options.recursive,
        danglingDependencies: Array.from(danglingDependencies),
        totalToRemove: formulasToRemove.length
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
    
    // Remove main formula from formula.yml or .formula.yml
    const removedFromYml = await removeFormulaFromYml(targetDir, formulaName);
    
    // Success output
    console.log(`✓ Formula '${formulaName}' uninstalled successfully`);
    console.log(`📁 Target directory: ${targetDir}`);
    
    if (options.recursive && danglingDependencies.size > 0) {
      console.log(`🗑️  Removed main formula: ai/${formulaName}`);
      console.log(`🗑️  Removed ${danglingDependencies.size} dangling dependencies:`);
      for (const dep of danglingDependencies) {
        if (removedDirectories.includes(dep)) {
          console.log(`   ├── ai/${dep}`);
        }
      }
      console.log(`📊 Total directories removed: ${removedDirectories.length}`);
    } else {
      console.log(`🗑️  Removed directory: ai/${formulaName}`);
    }
    
    if (removedFromYml) {
      console.log(`📋 Removed from formula dependencies`);
    } else {
      console.log(`⚠️  Could not update formula.yml (not found or formula not listed)`);
    }
    
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
        totalRemoved: removedDirectories.length
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

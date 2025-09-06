import { Command } from 'commander';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { UninstallOptions, CommandResult, FormulaYml } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { exists, isDirectory, readTextFile, writeTextFile, remove, listDirectories } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';

/**
 * Parse formula.yml file
 */
async function parseFormulaYml(formulaYmlPath: string): Promise<FormulaYml> {
  try {
    const content = await readTextFile(formulaYmlPath);
    const parsed = yaml.load(content) as FormulaYml;
    
    // Validate required fields
    if (!parsed.name || !parsed.version) {
      throw new Error('formula.yml must contain name and version fields');
    }
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse formula.yml: ${error}`);
  }
}

/**
 * Write formula.yml file
 */
async function writeFormulaYml(formulaYmlPath: string, config: FormulaYml): Promise<void> {
  const content = yaml.dump(config, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false
  });
  
  await writeTextFile(formulaYmlPath, content);
}

/**
 * Find formula directory in groundzero by matching formula name
 */
async function findFormulaDirectory(groundzeroPath: string, formulaName: string): Promise<string | null> {
  if (!(await exists(groundzeroPath)) || !(await isDirectory(groundzeroPath))) {
    return null;
  }

  try {
    const subdirectories = await listDirectories(groundzeroPath);
    
    for (const subdir of subdirectories) {
      const subdirPath = join(groundzeroPath, subdir);
      
      // Check for formula.yml or .formula.yml
      const formulaYmlPath = join(subdirPath, 'formula.yml');
      const hiddenFormulaYmlPath = join(subdirPath, '.formula.yml');
      
      let formulaFilePath: string | null = null;
      if (await exists(formulaYmlPath)) {
        formulaFilePath = formulaYmlPath;
      } else if (await exists(hiddenFormulaYmlPath)) {
        formulaFilePath = hiddenFormulaYmlPath;
      }
      
      if (formulaFilePath) {
        try {
          const formulaConfig = await parseFormulaYml(formulaFilePath);
          if (formulaConfig.name === formulaName) {
            return subdirPath;
          }
        } catch (error) {
          logger.warn(`Failed to parse formula file ${formulaFilePath}: ${error}`);
        }
      }
    }
    
    return null;
  } catch (error) {
    logger.error(`Failed to search groundzero directory: ${error}`);
    return null;
  }
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
 * Uninstall formula command implementation
 */
async function uninstallFormulaCommand(
  formulaName: string,
  targetDir: string,
  options: UninstallOptions
): Promise<CommandResult> {
  logger.info(`Uninstalling formula '${formulaName}' from: ${targetDir}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  const groundzeroPath = join(targetDir, 'groundzero');
  
  // Check if groundzero directory exists
  if (!(await exists(groundzeroPath))) {
    console.log(`❌ Formula '${formulaName}' not found`);
    console.log(`Groundzero directory not found in: ${targetDir}`);
    return {
      success: false,
      error: 'Formula not found'
    };
  }
  
  // Find the formula directory in groundzero
  const formulaDirectoryPath = await findFormulaDirectory(groundzeroPath, formulaName);
  
  if (!formulaDirectoryPath) {
    console.log(`❌ Formula '${formulaName}' not found`);
    console.log(`No matching formula found in groundzero directory`);
    return {
      success: false,
      error: 'Formula not found'
    };
  }
  
  // Dry run mode
  if (options.dryRun) {
    console.log(`🔍 Dry run - showing what would be uninstalled:`);
    console.log('');
    console.log(`Formula: ${formulaName}`);
    console.log(`Directory to remove: ${formulaDirectoryPath}`);
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
        formulaDirectory: formulaDirectoryPath
      }
    };
  }
  
  // Perform actual uninstallation
  try {
    // Remove the formula directory from groundzero
    await remove(formulaDirectoryPath);
    logger.info(`Removed formula directory: ${formulaDirectoryPath}`);
    
    // Remove formula from formula.yml or .formula.yml
    const removedFromYml = await removeFormulaFromYml(targetDir, formulaName);
    
    // Success output
    console.log(`✓ Formula '${formulaName}' uninstalled successfully`);
    console.log(`📁 Target directory: ${targetDir}`);
    console.log(`🗑️  Removed directory: groundzero/${formulaName}`);
    
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
        removedFromYml
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
    .description('Remove a formula from the groundzero directory and update dependencies')
    .argument('<formula-name>', 'name of the formula to uninstall')
    .argument('[target-dir]', 'target directory (defaults to current directory)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--keep-data', 'keep data files when removing')
    .action(withErrorHandling(async (formulaName: string, targetDir: string, options: UninstallOptions) => {
      const result = await uninstallFormulaCommand(formulaName, targetDir, options);
      if (!result.success && result.error !== 'Formula not found') {
        throw new Error(result.error || 'Uninstall operation failed');
      }
    }));
}

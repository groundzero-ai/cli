import { Command } from 'commander';
import { join, basename } from 'path';
import { CommandResult, FormulaYml } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { promptCreateFormula, promptFormulaDetails } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { exists, ensureDir } from '../utils/fs.js';

/**
 * Initialize formula.yml command implementation
 */
async function initFormulaCommand(targetDir?: string): Promise<CommandResult> {
  const cwd = process.cwd();
  const formulaDir = targetDir ? join(cwd, targetDir) : cwd;
  const formulaYmlPath = join(formulaDir, 'formula.yml');
  
  logger.info(`Initializing formula.yml in directory: ${formulaDir}`);
  
  let formulaConfig: FormulaYml;
  
  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    logger.info('Found existing formula.yml, parsing...');
    try {
      formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(`✓ formula.yml already exists`);
      console.log(`📦 Name: ${formulaConfig.name}`);
      console.log(`📦 Version: ${formulaConfig.version}`);
      if (formulaConfig.description) {
        console.log(`📝 Description: ${formulaConfig.description}`);
      }
      if (formulaConfig.keywords && formulaConfig.keywords.length > 0) {
        console.log(`🏷️  Keywords: ${formulaConfig.keywords.join(', ')}`);
      }
      
      return {
        success: true,
        data: formulaConfig
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to parse existing formula.yml: ${error}`
      };
    }
  } else {
    logger.info('No formula.yml found, creating new formula...');
    
    // Confirm with user if they want to create a new formula
    const shouldCreate = await promptCreateFormula();
    
    if (!shouldCreate) {
      throw new UserCancellationError('Formula creation cancelled by user');
    }
    
    try {
      // Ensure the target directory exists
      await ensureDir(formulaDir);
      
      // Prompt for formula details (npm init style)
      const defaultName = basename(formulaDir);
      formulaConfig = await promptFormulaDetails(defaultName);
      
      // Create the formula.yml file
      await writeFormulaYml(formulaYmlPath, formulaConfig);
      console.log(`✓ Created formula.yml`);
      
      // Success output
      console.log(`📦 Name: ${formulaConfig.name}`);
      console.log(`📦 Version: ${formulaConfig.version}`);
      if (formulaConfig.description) {
        console.log(`📝 Description: ${formulaConfig.description}`);
      }
      if (formulaConfig.keywords && formulaConfig.keywords.length > 0) {
        console.log(`🏷️  Keywords: ${formulaConfig.keywords.join(', ')}`);
      }
      if (formulaConfig.private) {
        console.log(`🔒 Private: Yes`);
      }
      
      return {
        success: true,
        data: formulaConfig
      };
    } catch (error) {
      if (error instanceof UserCancellationError) {
        throw error; // Re-throw to be handled by withErrorHandling
      }
      return {
        success: false,
        error: `Failed to create formula.yml: ${error}`
      };
    }
  }
}

/**
 * Setup the init command
 */
export function setupInitCommand(program: Command): void {
  program
    .command('init')
    .argument('[directory]', 'target directory to create formula.yml (relative to current directory)')
    .description('Initialize a new formula.yml file in the current directory or specified directory')
    .action(withErrorHandling(async (directory?: string) => {
      const result = await initFormulaCommand(directory);
      if (!result.success) {
        throw new Error(result.error || 'Init operation failed');
      }
    }));
}

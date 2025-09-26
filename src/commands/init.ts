import { Command } from 'commander';
import { basename } from 'path';
import { CommandResult, FormulaYml } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { promptCreateFormula, promptFormulaDetails } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { exists, ensureDir } from '../utils/fs.js';
import { getLocalGroundZeroDir, getLocalFormulaYmlPath } from '../utils/paths.js';

/**
 * Initialize formula.yml command implementation
 */
async function initFormulaCommand(): Promise<CommandResult> {
  const formulaDir = process.cwd();
  const groundzeroDir = getLocalGroundZeroDir(formulaDir);
  const formulaYmlPath = getLocalFormulaYmlPath(formulaDir);
  
  logger.info(`Initializing formula.yml in directory: ${groundzeroDir}`);
  
  let formulaConfig: FormulaYml;
  
  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    logger.info('Found existing formula.yml, parsing...');
    try {
      formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(`✓ .groundzero/formula.yml already exists`);
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
      
      // Ensure .groundzero directory exists
      await ensureDir(groundzeroDir);
      
      // Create the formula.yml file
      await writeFormulaYml(formulaYmlPath, formulaConfig);
      console.log(`✓ Created .groundzero/formula.yml`);
      
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
    .description('Initialize a new .groundzero/formula.yml file in the current directory')
    .action(withErrorHandling(async () => {
      const result = await initFormulaCommand();
      if (!result.success) {
        throw new Error(result.error || 'Init operation failed');
      }
    }));
}

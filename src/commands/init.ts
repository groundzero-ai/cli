import { Command } from 'commander';
import { basename, join, relative } from 'path';
import { CommandResult, FormulaYml } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { promptFormulaDetails, promptFormulaDetailsForNamed } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { displayFormulaConfig } from '../utils/formatters.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { exists, ensureDir } from '../utils/fs.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { getLocalOpenPackageDir, getLocalFormulaYmlPath, getLocalFormulaDir } from '../utils/paths.js';
import { normalizeFormulaName, validateFormulaName } from '../utils/formula-name.js';
import { createBasicFormulaYml, addFormulaToYml } from '../utils/formula-management.js';

/**
 * Initialize formula.yml command implementation
 */
async function initFormulaCommand(force?: boolean): Promise<CommandResult> {
  const formulaDir = process.cwd();
  const openpackageDir = getLocalOpenPackageDir(formulaDir);
  const formulaYmlPath = getLocalFormulaYmlPath(formulaDir);

  logger.info(`Initializing formula.yml in directory: ${openpackageDir}`);

  let formulaConfig: FormulaYml;

  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    if (force) {
      logger.info('Found existing formula.yml, forcing overwrite...');
      try {
        // Ensure .openpackage directory exists
        await ensureDir(openpackageDir);

        // Prompt for formula details (npm init style)
        const defaultName = basename(formulaDir);
        formulaConfig = await promptFormulaDetails(defaultName);

        // Create the formula.yml file
        await writeFormulaYml(formulaYmlPath, formulaConfig);
        displayFormulaConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), false);

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
          error: `Failed to overwrite formula.yml: ${error}`
        };
      }
    } else {
      logger.info('Found existing formula.yml, parsing...');
      try {
        formulaConfig = await parseFormulaYml(formulaYmlPath);
        displayFormulaConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), true);

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
    }
  } else {
    logger.info('No formula.yml found, creating new formula...');

    try {
      // Ensure the target directory exists
      await ensureDir(formulaDir);

      // Prompt for formula details (npm init style)
      const defaultName = basename(formulaDir);
      formulaConfig = await promptFormulaDetails(defaultName);

      // Ensure .openpackage directory exists
      await ensureDir(openpackageDir);

      // Create the formula.yml file
      await writeFormulaYml(formulaYmlPath, formulaConfig);
      displayFormulaConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), false);

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
 * Initialize formula.yml in the formulas directory for a specific formula name
 */
async function initFormulaInFormulasDir(formulaName: string, force?: boolean): Promise<CommandResult> {
  const cwd = process.cwd();

  // Validate and normalize formula name for consistent behavior
  validateFormulaName(formulaName);
  const normalizedFormulaName = normalizeFormulaName(formulaName);

  // Ensure root .openpackage/formula.yml exists; do not overwrite if present
  await createBasicFormulaYml(cwd, false);

  // Get the formula directory path (.openpackage/formulas/{formulaName})
  const formulaDir = getLocalFormulaDir(cwd, normalizedFormulaName);
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  logger.info(`Initializing formula.yml for '${formulaName}' in directory: ${formulaDir}`);

  let formulaConfig: FormulaYml;

  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    logger.info('Found existing formula.yml, parsing...');
    try {
      formulaConfig = await parseFormulaYml(formulaYmlPath);
      displayFormulaConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), true);

      // Link formula dependency into root formula.yml
      await addFormulaToYml(cwd, normalizedFormulaName, formulaConfig.version);

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

    try {
      // Ensure the formula directory exists
      await ensureDir(formulaDir);

      // Prompt for formula details (skip name prompt since it's provided)
      formulaConfig = await promptFormulaDetailsForNamed(normalizedFormulaName);

      // Create the formula.yml file
      await writeFormulaYml(formulaYmlPath, formulaConfig);
      displayFormulaConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), false);

      // Link formula dependency into root formula.yml
      await addFormulaToYml(cwd, normalizedFormulaName, formulaConfig.version);

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
    .argument('[formula-name]', 'formula name for initialization in .openpackage/formulas/ (optional)')
    .description('Initialize a new formula.yml file. \n' +
      'Usage patterns:\n' +
      '  opn init                    # Initialize .openpackage/formula.yml in current directory\n' +
      '  opn init <formula-name>     # Initialize .openpackage/formulas/<formula-name>/formula.yml')
    .option('-f, --force', 'overwrite existing root .openpackage/formula.yml (no effect for named init root patch)')
    .action(withErrorHandling(async (formulaName?: string, options?: { force?: boolean }) => {
      if (formulaName) {
        const result = await initFormulaInFormulasDir(formulaName, options?.force);
        if (!result.success) {
          throw new Error(result.error || 'Init operation failed');
        }
      } else {
        const result = await initFormulaCommand(options?.force);
        if (!result.success) {
          throw new Error(result.error || 'Init operation failed');
        }
      }
    }));
}

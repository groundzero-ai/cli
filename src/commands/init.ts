import { Command } from 'commander';
import { basename, join, relative } from 'path';
import { CommandResult, PackageYml } from '../types/index.js';
import { parsePackageYml, writePackageYml } from '../utils/package-yml.js';
import { promptPackageDetails, promptPackageDetailsForNamed } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { displayPackageConfig } from '../utils/formatters.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { exists, ensureDir } from '../utils/fs.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { getLocalOpenPackageDir, getLocalPackageYmlPath, getLocalPackageDir } from '../utils/paths.js';
import { normalizePackageName, validatePackageName } from '../utils/package-name.js';
import { createBasicPackageYml, addPackageToYml } from '../utils/package-management.js';

/**
 * Initialize formula.yml command implementation
 */
async function initPackageCommand(force?: boolean): Promise<CommandResult> {
  const formulaDir = process.cwd();
  const openpackageDir = getLocalOpenPackageDir(formulaDir);
  const formulaYmlPath = getLocalPackageYmlPath(formulaDir);

  logger.info(`Initializing formula.yml in directory: ${openpackageDir}`);

  let formulaConfig: PackageYml;

  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    if (force) {
      logger.info('Found existing formula.yml, forcing overwrite...');
      try {
        // Ensure .openpackage directory exists
        await ensureDir(openpackageDir);

        // Prompt for formula details (npm init style)
        const defaultName = basename(formulaDir);
        formulaConfig = await promptPackageDetails(defaultName);

        // Create the formula.yml file
        await writePackageYml(formulaYmlPath, formulaConfig);
        displayPackageConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), false);

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
        formulaConfig = await parsePackageYml(formulaYmlPath);
        displayPackageConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), true);

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
      formulaConfig = await promptPackageDetails(defaultName);

      // Ensure .openpackage directory exists
      await ensureDir(openpackageDir);

      // Create the formula.yml file
      await writePackageYml(formulaYmlPath, formulaConfig);
      displayPackageConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), false);

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
async function initPackageInPackagesDir(formulaName: string, force?: boolean): Promise<CommandResult> {
  const cwd = process.cwd();

  // Validate and normalize formula name for consistent behavior
  validatePackageName(formulaName);
  const normalizedPackageName = normalizePackageName(formulaName);

  // Ensure root .openpackage/formula.yml exists; do not overwrite if present
  await createBasicPackageYml(cwd, false);

  // Get the formula directory path (.openpackage/formulas/{formulaName})
  const formulaDir = getLocalPackageDir(cwd, normalizedPackageName);
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  logger.info(`Initializing formula.yml for '${formulaName}' in directory: ${formulaDir}`);

  let formulaConfig: PackageYml;

  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    logger.info('Found existing formula.yml, parsing...');
    try {
      formulaConfig = await parsePackageYml(formulaYmlPath);
      displayPackageConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), true);

      // Link formula dependency into root formula.yml
      await addPackageToYml(cwd, normalizedPackageName, formulaConfig.version);

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
      formulaConfig = await promptPackageDetailsForNamed(normalizedPackageName);

      // Create the formula.yml file
      await writePackageYml(formulaYmlPath, formulaConfig);
      displayPackageConfig(formulaConfig, relative(process.cwd(), formulaYmlPath), false);

      // Link formula dependency into root formula.yml
      await addPackageToYml(cwd, normalizedPackageName, formulaConfig.version);

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
    .argument('[package-name]', 'formula name for initialization in .openpackage/formulas/ (optional)')
    .description('Initialize a new formula.yml file. \n' +
      'Usage patterns:\n' +
      '  opn init                    # Initialize .openpackage/formula.yml in current directory\n' +
      '  opn init <package-name>     # Initialize .openpackage/formulas/<package-name>/formula.yml')
    .option('-f, --force', 'overwrite existing root .openpackage/formula.yml (no effect for named init root patch)')
    .action(withErrorHandling(async (formulaName?: string, options?: { force?: boolean }) => {
      if (formulaName) {
        const result = await initPackageInPackagesDir(formulaName, options?.force);
        if (!result.success) {
          throw new Error(result.error || 'Init operation failed');
        }
      } else {
        const result = await initPackageCommand(options?.force);
        if (!result.success) {
          throw new Error(result.error || 'Init operation failed');
        }
      }
    }));
}

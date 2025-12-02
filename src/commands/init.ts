import { Command } from 'commander';
import { basename, relative } from 'path';
import { CommandResult, PackageYml } from '../types/index.js';
import { parsePackageYml, writePackageYml } from '../utils/package-yml.js';
import { promptPackageDetails } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { displayPackageConfig } from '../utils/formatters.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { exists, ensureDir } from '../utils/fs.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { getLocalOpenPackageDir, getLocalPackageYmlPath, getLocalPackageDir } from '../utils/paths.js';
import { normalizePackageName, validatePackageName } from '../utils/package-name.js';
import { createWorkspacePackageYml, addPackageToYml, ensurePackageWithYml } from '../utils/package-management.js';

/**
 * Initialize package.yml command implementation
 */
async function initPackageCommand(force?: boolean): Promise<CommandResult> {
  const packageDir = process.cwd();
  const openpackageDir = getLocalOpenPackageDir(packageDir);
  const packageYmlPath = getLocalPackageYmlPath(packageDir);

  logger.info(`Initializing package.yml in directory: ${openpackageDir}`);

  let packageConfig: PackageYml;

  // Check if package.yml already exists
  if (await exists(packageYmlPath)) {
    if (force) {
      logger.info('Found existing package.yml, forcing overwrite...');
      try {
        // Ensure .openpackage directory exists
        await ensureDir(openpackageDir);

        // Prompt for package details (npm init style)
        const defaultName = basename(packageDir);
        packageConfig = await promptPackageDetails(defaultName);

        // Create the package.yml file
        await writePackageYml(packageYmlPath, packageConfig);
        displayPackageConfig(packageConfig, relative(process.cwd(), packageYmlPath), false);

        return {
          success: true,
          data: packageConfig
        };
      } catch (error) {
        if (error instanceof UserCancellationError) {
          throw error; // Re-throw to be handled by withErrorHandling
        }
        return {
          success: false,
          error: `Failed to overwrite package.yml: ${error}`
        };
      }
    } else {
      logger.info('Found existing package.yml, parsing...');
      try {
        packageConfig = await parsePackageYml(packageYmlPath);
        displayPackageConfig(packageConfig, relative(process.cwd(), packageYmlPath), true);

        return {
          success: true,
          data: packageConfig
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to parse existing package.yml: ${error}`
        };
      }
    }
  } else {
    logger.info('No package.yml found, creating new package...');

    try {
      // Ensure the target directory exists
      await ensureDir(packageDir);

      // Prompt for package details (npm init style)
      const defaultName = basename(packageDir);
      packageConfig = await promptPackageDetails(defaultName);

      // Ensure .openpackage directory exists
      await ensureDir(openpackageDir);

      // Create the package.yml file
      await writePackageYml(packageYmlPath, packageConfig);
      displayPackageConfig(packageConfig, relative(process.cwd(), packageYmlPath), false);

      return {
        success: true,
        data: packageConfig
      };
    } catch (error) {
      if (error instanceof UserCancellationError) {
        throw error; // Re-throw to be handled by withErrorHandling
      }
      return {
        success: false,
        error: `Failed to create package.yml: ${error}`
      };
    }
  }
}

/**
 * Initialize package.yml in the packages directory for a specific package name
 */
async function initPackageInPackagesDir(packageName: string, force?: boolean): Promise<CommandResult> {
  const cwd = process.cwd();

  // Validate and normalize package name for consistent behavior
  validatePackageName(packageName);
  const normalizedPackageName = normalizePackageName(packageName);

  // Ensure root .openpackage/package.yml exists; do not overwrite if present
  await createWorkspacePackageYml(cwd, false);

  const packageDir = getLocalPackageDir(cwd, normalizedPackageName);
  logger.info(`Initializing package.yml for '${packageName}' in directory: ${packageDir}`);

  try {
    const ensuredPackage = await ensurePackageWithYml(cwd, normalizedPackageName, {
      interactive: true
    });

    if (ensuredPackage.isNew) {
      logger.info('No package.yml found, creating new package...');
    } else {
      logger.info('Found existing package.yml, parsing...');
    }

    displayPackageConfig(
      ensuredPackage.packageConfig,
      relative(process.cwd(), ensuredPackage.packageYmlPath),
      !ensuredPackage.isNew
    );

    // Link package dependency into root package.yml
    await addPackageToYml(cwd, ensuredPackage.normalizedName, ensuredPackage.packageConfig.version);

    return {
      success: true,
      data: ensuredPackage.packageConfig
    };
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
    return {
      success: false,
      error: `Failed to initialize package.yml: ${error}`
    };
  }
}

/**
 * Setup the init command
 */
export function setupInitCommand(program: Command): void {
  program
    .command('init')
    .argument('[package-name]', 'package name for initialization in .openpackage/packages/ (optional)')
    .description('Initialize a new package.yml file. \n' +
      'Usage patterns:\n' +
      '  opkg init                    # Initialize .openpackage/package.yml in current directory\n' +
      '  opkg init <package-name>     # Initialize .openpackage/packages/<package-name>/package.yml')
    .option('-f, --force', 'overwrite existing root .openpackage/package.yml (no effect for named init root patch)')
    .action(withErrorHandling(async (packageName?: string, options?: { force?: boolean }) => {
      if (packageName) {
        const result = await initPackageInPackagesDir(packageName, options?.force);
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

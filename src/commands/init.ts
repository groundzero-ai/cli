import { Command } from 'commander';
import { basename, relative } from 'path';
import { CommandResult, PackageYml } from '../types/index.js';
import { parsePackageYml, writePackageYml } from '../utils/package-yml.js';
import { promptPackageDetails, promptPackageDetailsForNamed } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { displayPackageConfig } from '../utils/formatters.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { exists, ensureDir } from '../utils/fs.js';
import { 
  detectPackageContext,
  getPackageYmlPath,
  getPackageFilesDir,
  createPackageContext,
  type PackageContext 
} from '../core/package-context.js';
import { normalizePackageName, validatePackageName } from '../utils/package-name.js';
import { createWorkspacePackageYml, addPackageToYml } from '../utils/package-management.js';

/**
 * Initialize root package (cwd as package)
 */
async function initRootPackage(force?: boolean): Promise<CommandResult<PackageContext>> {
  const cwd = process.cwd();
  const packageYmlPath = getPackageYmlPath(cwd, 'root');
  const packageFilesDir = getPackageFilesDir(cwd, 'root');

  logger.info(`Initializing root package in: ${packageFilesDir}`);

  // Check if already exists
  const existingContext = await detectPackageContext(cwd);
  
  if (existingContext && existingContext.location === 'root') {
    if (!force) {
      logger.info('Found existing root package.yml');
      displayPackageConfig(existingContext.config, relative(cwd, packageYmlPath), true);
      return { success: true, data: existingContext };
    }
    logger.info('Found existing package.yml, forcing overwrite...');
  }

  try {
    await ensureDir(packageFilesDir);
    
    const defaultName = basename(cwd);
    const packageConfig = await promptPackageDetails(defaultName);
    
    await writePackageYml(packageYmlPath, packageConfig);
    
    const context = createPackageContext(cwd, packageConfig, 'root');
    displayPackageConfig(packageConfig, relative(cwd, packageYmlPath), false);

    return { success: true, data: context };
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error;
    }
    return { success: false, error: `Failed to initialize root package: ${error}` };
  }
}

/**
 * Initialize nested package
 */
async function initNestedPackage(packageName: string, force?: boolean): Promise<CommandResult<PackageContext>> {
  const cwd = process.cwd();

  validatePackageName(packageName);
  const normalizedName = normalizePackageName(packageName);

  // Ensure root package.yml exists
  await createWorkspacePackageYml(cwd, false);

  // Check if package already exists
  const existingContext = await detectPackageContext(cwd, normalizedName);
  
  if (existingContext) {
    if (existingContext.location === 'root') {
      return {
        success: false,
        error: `Package '${packageName}' matches the root package name. Use 'opkg init' without arguments to reinitialize the root package.`
      };
    }
    
    if (!force) {
      logger.info('Found existing nested package');
      displayPackageConfig(existingContext.config, relative(cwd, existingContext.packageYmlPath), true);
      return { success: true, data: existingContext };
    }
  }

  const packageFilesDir = getPackageFilesDir(cwd, 'nested', normalizedName);
  const packageYmlPath = getPackageYmlPath(cwd, 'nested', normalizedName);

  logger.info(`Initializing nested package '${normalizedName}' in: ${packageFilesDir}`);

  try {
    await ensureDir(packageFilesDir);
    
    const packageConfig = await promptPackageDetailsForNamed(normalizedName);
    
    // Ensure include pattern is set
    if (!packageConfig.include || packageConfig.include.length === 0) {
      packageConfig.include = ['**'];
    }
    
    await writePackageYml(packageYmlPath, packageConfig);
    
    const context = createPackageContext(cwd, packageConfig, 'nested');
    displayPackageConfig(packageConfig, relative(cwd, packageYmlPath), false);

    // Add to root package dependencies
    await addPackageToYml(cwd, normalizedName, packageConfig.version);

    return { success: true, data: context };
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error;
    }
    return { success: false, error: `Failed to initialize nested package: ${error}` };
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
    .option('-f, --force', 'overwrite existing package.yml')
    .action(withErrorHandling(async (packageName?: string, options?: { force?: boolean }) => {
      const result = packageName
        ? await initNestedPackage(packageName, options?.force)
        : await initRootPackage(options?.force);
      
      if (!result.success) {
        throw new Error(result.error || 'Init operation failed');
      }
    }));
}

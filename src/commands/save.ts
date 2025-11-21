import { VERSION_TYPE_STABLE, WIP_SUFFIX } from './../core/save/constants.js';
import { Command } from 'commander';
import { SaveOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { addPackageToYml, createBasicPackageYml } from '../utils/package-management.js';
import { performPlatformSync } from '../core/sync/platform-sync.js';
import { parsePackageInput, normalizePackageName } from '../utils/package-name.js';
import { discoverPackageFilesForSave } from '../core/save/save-file-discovery.js';
import { ERROR_MESSAGES, LOG_PREFIXES } from '../core/save/constants.js';
import { getOrCreatePackageYml } from '../core/save/package-yml-generator.js';
import { savePackageToRegistry } from '../core/save/package-saver.js';
import { packageVersionExists } from '../utils/package-versioning.js';
import { applyWorkspacePackageRename } from '../core/save/workspace-rename.js';
import { isPackageTransitivelyCovered } from '../utils/dependency-coverage.js';

/**
 * Main implementation of the save package command
 * Now only supports specifying the package name (optionally with @version)
 * @param packageName - Package name (optionally name@version)
 * @param versionType - Optional version type ('stable')
 * @param options - Command options (force, bump, etc.)
 * @returns Promise resolving to command result
 */
async function savePackageCommand(
  packageName: string,
  versionType?: string,
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();

  // Ensure the workspace-level package.yml exists for dependency tracking
  await createBasicPackageYml(cwd);

  // Parse inputs to determine the pattern being used
  const { name, version: explicitVersion } = parsePackageInput(packageName);

  const renameInput = options?.rename?.trim();
  let renameTarget: string | undefined;
  let renameVersion: string | undefined;

  if (renameInput) {
    const { name: renameName, version: renameVer } = parsePackageInput(renameInput);
    const normalizedRename = normalizePackageName(renameName);
    if (normalizedRename !== name) {
      renameTarget = normalizedRename;
      renameVersion = renameVer;
      logger.debug(`Renaming package during save`, { from: name, to: renameTarget, version: renameVersion });
    }
  }

  logger.debug(`Saving package with name: ${name}`, { explicitVersion, options });

  // Initialize package environment
  await ensureRegistryDirectories();

  // Get package configuration based on input pattern
  // Use rename version if provided, otherwise use original version
  const packageVersion = renameVersion || explicitVersion;
  let packageInfo = await getOrCreatePackageYml(cwd, name, packageVersion, versionType, options?.bump, options?.force);
  let packageConfig = packageInfo.config;
  let isRootPackage = packageInfo.isRootPackage;
  let targetVersion = packageConfig.version;
  let isWipVersion = targetVersion.endsWith(WIP_SUFFIX);

  if (renameTarget) {
    if (!(options?.force || isWipVersion)) {
      const targetExists = await packageVersionExists(renameTarget, targetVersion);
      if (targetExists) {
        throw new Error(`Version ${renameTarget}@${targetVersion} already exists. Use --force to overwrite.`);
      }
    }

    await applyWorkspacePackageRename(cwd, packageInfo, renameTarget);

    // Re-fetch package info at the new location with the same target version
    packageInfo = await getOrCreatePackageYml(
      cwd,
      renameTarget,
      targetVersion,
      versionType,
      undefined,
      /* force */ true
    );
    packageConfig = packageInfo.config;
    isRootPackage = packageInfo.isRootPackage;
    targetVersion = packageConfig.version;
    isWipVersion = targetVersion.endsWith(WIP_SUFFIX);
  }

  // Discover and process files directly into package files array
  // Only use explicit --force flag to skip prompts; WIP versions should still prompt for conflicts
  const packageFiles = await discoverPackageFilesForSave(packageInfo, {
    force: options?.force
  });

  // Save package to local registry
  const saveResult = await savePackageToRegistry(packageInfo, packageFiles);

  if (!saveResult.success) {
    return { success: false, error: saveResult.error || ERROR_MESSAGES.SAVE_FAILED };
  }

  // Sync universal files across detected platforms using planner-based workflow
  const syncResult = await performPlatformSync(
    cwd,
    packageConfig.name,
    packageConfig.version,
    packageFiles,
    {
      force: options?.force,
      conflictStrategy: options?.force ? 'overwrite' : 'ask'
    }
  );

  // Finalize the save operation
  // Don't add root package to itself as a dependency
  if (!options?.skipProjectLink && !isRootPackage) {
    const transitivelyCovered = await isPackageTransitivelyCovered(cwd, packageConfig.name);
    if (!transitivelyCovered) {
      await addPackageToYml(
        cwd,
        packageConfig.name,
        packageConfig.version,
        /* isDev */ false,
        /* originalVersion */ undefined,
        /* silent */ true
      );
    } else {
      logger.debug(`Skipping addition of ${packageConfig.name} to package.yml; already covered transitively.`);
    }
  }
  
  // Display appropriate message based on package type
  const packageType = isRootPackage ? 'root package' : 'package';
  console.log(`${LOG_PREFIXES.SAVED} ${packageConfig.name}@${packageConfig.version} (${packageType}, ${packageFiles.length} files):`);
  if (packageFiles.length > 0) {
    const savedPaths = packageFiles.map(f => f.path);
    const sortedSaved = [...savedPaths].sort((a, b) => a.localeCompare(b));
    for (const savedPath of sortedSaved) {
      console.log(`   ├── ${savedPath}`);
    }
  }

  // Display platform sync results
  const totalCreated = syncResult.created.length;
  const totalUpdated = syncResult.updated.length;
  const totalDeleted = syncResult.deleted?.length ?? 0;

  if (totalCreated > 0) {
    const allCreated = [...syncResult.created].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync created ${totalCreated} files:`);
    for (const createdFile of allCreated) {
      console.log(`   ├── ${createdFile}`);
    }
  }

  if (totalUpdated > 0) {
    const allUpdated = [...syncResult.updated].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync updated ${totalUpdated} files:`);
    for (const updatedFile of allUpdated) {
      console.log(`   ├── ${updatedFile}`);
    }
  }

  if (totalDeleted > 0 && syncResult.deleted) {
    const allDeleted = [...syncResult.deleted].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync removed ${totalDeleted} files:`);
    for (const deletedFile of allDeleted) {
      console.log(`   ├── ${deletedFile}`);
    }
  }

  return { success: true, data: packageConfig };
}


/**
 * Setup the save command
 */
export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .alias('s')
    .argument('<package-name>', 'package name (optionally package-name@version)')
    .argument('[version-type]', 'version type: stable (optional)')
    .description('Save a package to local registry.\n' +
      'Usage:\n' +
      '  opkg save <package-name>                # Detects files and saves to registry\n' +
      '  opkg save <package-name> stable        # Save as stable version (with optional --bump)\n' +
      'Auto-generates local dev versions by default.')
    .option('-f, --force', 'overwrite existing version or skip confirmations')
    .option('-b, --bump <type>', `bump version (patch|minor|major). Creates prerelease by default, stable when combined with "${VERSION_TYPE_STABLE}" argument`)
    .option('--rename <newName>', 'Rename package during save (optionally newName@version)')
    .action(withErrorHandling(async (packageName: string, versionType?: string, options?: SaveOptions) => {
      // Validate version type argument
      if (versionType && versionType !== VERSION_TYPE_STABLE) {
        throw new ValidationError(ERROR_MESSAGES.INVALID_VERSION_TYPE.replace('%s', versionType).replace('%s', VERSION_TYPE_STABLE));
      }

      const result = await savePackageCommand(packageName, versionType, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}

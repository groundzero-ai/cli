import { Command } from 'commander';
import { SaveOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { addPackageToYml, createBasicPackageYml } from '../utils/package-management.js';
import { performPlatformSync } from '../core/sync/platform-sync.js';
import { parsePackageInput, normalizePackageName } from '../utils/package-name.js';
import { discoverPackageFilesForSave } from '../core/save/save-file-discovery.js';
import { LOG_PREFIXES } from '../core/save/constants.js';
import { readOrCreateBasePackageYml, type PackageYmlInfo } from '../core/save/package-yml-generator.js';
import { applyWorkspacePackageRename } from '../core/save/workspace-rename.js';
import { isPackageTransitivelyCovered } from '../utils/dependency-coverage.js';
import { resolveEffectiveNameForSave } from '../core/scoping/package-scoping.js';
import { readPackageIndex } from '../utils/package-index-yml.js';
import { createWorkspaceHash } from '../utils/version-generator.js';
import { computeWipVersion } from '../core/save/save-versioning.js';
import { savePackageToRegistry } from '../core/save/package-saver.js';
import { deleteWorkspaceWipCopies } from '../core/save/workspace-wip-cleanup.js';
import { writePackageYml } from '../utils/package-yml.js';

/**
 * Main implementation of the save package command
 * Now only supports specifying the package name (no @version syntax)
 * @param packageName - Package name (optionally name@version)
 * @param options - Command options (force, rename, etc.)
 * @returns Promise resolving to command result
 */
async function savePackageCommand(
  packageName: string,
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();

  // Ensure the workspace-level package.yml exists for dependency tracking
  await createBasicPackageYml(cwd);

  // Parse inputs to determine the pattern being used
  const { name, version: explicitVersion } = parsePackageInput(packageName);
  if (explicitVersion) {
    throw new ValidationError(
      'Save command does not accept explicit versions. Edit package.yml to change the stable line.'
    );
  }
  const nameResolution = await resolveEffectiveNameForSave(name);
  const resolvedName = nameResolution.effectiveName;

  const renameInput = options?.rename?.trim();
  let renameTarget: string | undefined;

  if (renameInput) {
    const { name: renameName, version: renameVer } = parsePackageInput(renameInput);
    if (renameVer) {
      throw new ValidationError('Rename target cannot include a version when using save.');
    }
    const normalizedRename = normalizePackageName(renameName);
    if (normalizedRename !== name) {
      renameTarget = normalizedRename;
      logger.debug(`Renaming package during save`, { from: name, to: renameTarget });
    }
  } else if (nameResolution.nameChanged) {
    renameTarget = resolvedName;
    logger.debug(`Applying scoped name resolution for save`, { from: name, to: renameTarget });
    console.log(`✓ Using scoped package name '${renameTarget}' for save operation`);
  }

  logger.debug(`Saving package with name: ${resolvedName}`, { options });

  // Initialize package environment
  await ensureRegistryDirectories();

  let packageInfo: PackageYmlInfo = await readOrCreateBasePackageYml(cwd, name);
  let packageConfig = packageInfo.config;
  let isRootPackage = packageInfo.isRootPackage;

  if (renameTarget) {
    await applyWorkspacePackageRename(cwd, packageInfo, renameTarget);

    // Re-fetch package info at the new location with the same target version
    packageInfo = await readOrCreateBasePackageYml(cwd, renameTarget);
    packageConfig = packageInfo.config;
    isRootPackage = packageInfo.isRootPackage;
  }

  const indexRecord = await readPackageIndex(cwd, packageConfig.name);
  const workspaceHash = createWorkspaceHash(cwd);
  const wipVersionInfo = computeWipVersion(
    packageConfig.version,
    indexRecord?.workspace?.version,
    workspaceHash
  );
  if (wipVersionInfo.resetMessage) {
    console.log(wipVersionInfo.resetMessage);
  }
  const effectiveConfig = { ...packageConfig, version: wipVersionInfo.wipVersion };

  // Discover and process files directly into package files array
  // Only use explicit --force flag to skip prompts; WIP versions should still prompt for conflicts
  const packageFiles = await discoverPackageFilesForSave(packageInfo, {
    force: options?.force
  });

  // Sync universal files across detected platforms using planner-based workflow
  const syncResult = await performPlatformSync(
    cwd,
    effectiveConfig.name,
    effectiveConfig.version,
    packageFiles,
    {
      force: options?.force,
      conflictStrategy: options?.force ? 'overwrite' : 'ask'
    }
  );

  const registrySave = await savePackageToRegistry(
    { ...packageInfo, config: effectiveConfig },
    packageFiles
  );
  if (!registrySave.success) {
    return { success: false, error: registrySave.error || 'Save operation failed' };
  }

  await deleteWorkspaceWipCopies(effectiveConfig.name, workspaceHash, {
    keepVersion: effectiveConfig.version
  });

  // If the last workspace version was a stable S matching package.yml.version,
  // begin the next development cycle by bumping package.yml.version to patch(S)
  // after a successful save. This keeps new WIP saves on the next stable line
  // while leaving freshly installed workspaces at their packed stable until
  // they perform a save.
  if (wipVersionInfo.shouldBumpPackageYml && wipVersionInfo.nextStable) {
    try {
      const bumpedConfig = { ...packageConfig, version: wipVersionInfo.nextStable };
      await writePackageYml(packageInfo.fullPath, bumpedConfig);
      console.log(
        `✓ Updated package.yml.version to ${wipVersionInfo.nextStable} for the next cycle`
      );
    } catch (error) {
      logger.warn(`Failed to auto-bump package.yml after save: ${String(error)}`);
    }
  }

  // Finalize the save operation
  // Don't add root package to itself as a dependency
  if (!isRootPackage) {
    const transitivelyCovered = await isPackageTransitivelyCovered(cwd, effectiveConfig.name);
    if (!transitivelyCovered) {
      await addPackageToYml(
        cwd,
        effectiveConfig.name,
        effectiveConfig.version,
        /* isDev */ false,
        /* originalVersion */ undefined,
        /* silent */ true
      );
    } else {
      logger.debug(`Skipping addition of ${effectiveConfig.name} to package.yml; already covered transitively.`);
    }
  }
  
  // Display appropriate message based on package type
  const packageType = isRootPackage ? 'root package' : 'package';
  console.log(`${LOG_PREFIXES.SAVED} ${effectiveConfig.name}@${effectiveConfig.version} (${packageType}, ${packageFiles.length} files):`);
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

  return { success: true, data: effectiveConfig };
}


/**
 * Setup the save command
 */
export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .alias('s')
    .argument('<package-name>', 'package name (no @version syntax)')
    .description('Save a package snapshot for this workspace.\n' +
      'Usage:\n' +
      '  opkg save <package-name>                # Detects files, syncs platforms, records WIP metadata\n' +
      'Use `opkg pack` to create a stable copy in the registry.')
    .option('-f, --force', 'overwrite existing version or skip confirmations')
    .option('--rename <newName>', 'Rename package during save')
    .action(withErrorHandling(async (packageName: string, options?: SaveOptions) => {
      const result = await savePackageCommand(packageName, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}

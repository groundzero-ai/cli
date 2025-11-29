import { Command } from 'commander';
import { PackOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { addPackageToYml, createBasicPackageYml } from '../utils/package-management.js';
import { performPlatformSync } from '../core/sync/platform-sync.js';
import { parsePackageInput, normalizePackageName } from '../utils/package-name.js';
import { discoverPackageFilesForSave } from '../core/save/save-file-discovery.js';
import { LOG_PREFIXES, ERROR_MESSAGES } from '../core/save/constants.js';
import { readOrCreateBasePackageYml, type PackageYmlInfo } from '../core/save/package-yml-generator.js';
import { applyWorkspacePackageRename } from '../core/save/workspace-rename.js';
import { isPackageTransitivelyCovered } from '../utils/dependency-coverage.js';
import { resolveEffectiveNameForSave } from '../core/scoping/package-scoping.js';
import { readPackageIndex, writePackageIndex } from '../utils/package-index-yml.js';
import { createWorkspaceHash, createWorkspaceTag } from '../utils/version-generator.js';
import { computePackTargetVersion } from '../core/save/save-versioning.js';
import { savePackageToRegistry } from '../core/save/package-saver.js';
import { packageVersionExists } from '../utils/package-versioning.js';
import { deleteWorkspaceWipCopies } from '../core/save/workspace-wip-cleanup.js';
import { formatRegistryPathForDisplay } from '../utils/registry-paths.js';

async function packPackageCommand(
  packageName: string,
  options?: PackOptions
): Promise<CommandResult> {
  const cwd = process.cwd();

  await createBasicPackageYml(cwd);

  const { name, version: explicitVersion } = parsePackageInput(packageName);
  if (explicitVersion) {
    throw new ValidationError(
      'Pack command does not accept explicit versions. Edit package.yml to change the stable line.'
    );
  }

  const nameResolution = await resolveEffectiveNameForSave(name);
  const resolvedName = nameResolution.effectiveName;

  const renameInput = options?.rename?.trim();
  let renameTarget: string | undefined;

  if (renameInput) {
    const { name: renameName, version: renameVer } = parsePackageInput(renameInput);
    if (renameVer) {
      throw new ValidationError('Rename target cannot include a version when using pack.');
    }
    const normalizedRename = normalizePackageName(renameName);
    if (normalizedRename !== name) {
      renameTarget = normalizedRename;
      logger.debug(`Renaming package during pack`, { from: name, to: renameTarget });
    }
  } else if (nameResolution.nameChanged) {
    renameTarget = resolvedName;
    logger.debug(`Applying scoped name resolution for pack`, { from: name, to: renameTarget });
    console.log(`✓ Using scoped package name '${renameTarget}' for pack operation`);
  }

  logger.debug(`Packing package with name: ${resolvedName}`, { options });

  await ensureRegistryDirectories();

  let packageInfo: PackageYmlInfo = await readOrCreateBasePackageYml(cwd, name);
  let packageConfig = packageInfo.config;
  let isRootPackage = packageInfo.isRootPackage;

  if (renameTarget) {
    await applyWorkspacePackageRename(cwd, packageInfo, renameTarget);
    packageInfo = await readOrCreateBasePackageYml(cwd, renameTarget);
    packageConfig = packageInfo.config;
    isRootPackage = packageInfo.isRootPackage;
  }

  const indexRecord = await readPackageIndex(cwd, packageConfig.name);
  const workspaceHash = createWorkspaceHash(cwd);
  const workspaceTag = createWorkspaceTag(cwd);

  const packVersionInfo = computePackTargetVersion(
    packageConfig.version,
    indexRecord?.workspace?.version
  );
  if (packVersionInfo.resetMessage) {
    console.log(packVersionInfo.resetMessage);
  }
  const effectiveConfig = { ...packageConfig, version: packVersionInfo.targetVersion };

  if (!(options?.force)) {
    const exists = await packageVersionExists(effectiveConfig.name, effectiveConfig.version);
    if (exists) {
      throw new Error(
        ERROR_MESSAGES.VERSION_EXISTS.replace('%s', effectiveConfig.version)
      );
    }
  }

  const packageFiles = await discoverPackageFilesForSave(packageInfo, {
    force: options?.force
  });

  const registrySave = await savePackageToRegistry(
    { ...packageInfo, config: effectiveConfig },
    packageFiles
  );

  if (!registrySave.success) {
    return { success: false, error: registrySave.error || 'Pack operation failed' };
  }

  await deleteWorkspaceWipCopies(effectiveConfig.name, workspaceTag);

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

  // Update package.index.yml workspace.version to the just-packed stable version
  if (indexRecord) {
    await writePackageIndex({
      ...indexRecord,
      workspace: {
        hash: workspaceHash,
        version: effectiveConfig.version
      }
    });
  }

  const packageType = isRootPackage ? 'root package' : 'package';
  console.log(`${LOG_PREFIXES.SAVED} ${effectiveConfig.name}@${effectiveConfig.version} (${packageType}, ${packageFiles.length} files):`);
  if (packageFiles.length > 0) {
    const savedPaths = packageFiles.map(f => f.path);
    const sortedSaved = [...savedPaths].sort((a, b) => a.localeCompare(b));
    for (const savedPath of sortedSaved) {
      console.log(`   ├── ${formatRegistryPathForDisplay(savedPath)}`);
    }
  }

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
  return { success: true, data: { config: effectiveConfig, packVersionInfo } };
}

export function setupPackCommand(program: Command): void {
  program
    .command('pack')
    .argument('<package-name>', 'package name (no @version syntax)')
    .description('Promote the current workspace package to a stable registry copy.')
    .option('-f, --force', 'overwrite existing stable versions or skip confirmations')
    .option('--rename <newName>', 'Rename package during pack')
    .action(withErrorHandling(async (packageName: string, options?: PackOptions) => {
      const result = await packPackageCommand(packageName, options);
      if (!result.success) {
        throw new Error(result.error || 'Pack operation failed');
      }
    }));
}


import { join } from 'path';

import { CommandResult, PackageFile } from '../../types/index.js';
import { ensureRegistryDirectories } from '../directory.js';
import { logger } from '../../utils/logger.js';
import { addPackageToYml, createWorkspacePackageYml } from '../../utils/package-management.js';
import { performPlatformSync, PlatformSyncResult } from '../sync/platform-sync.js';
import { LOG_PREFIXES, ERROR_MESSAGES, MODE_LABELS } from './constants.js';
import { type PackageYmlInfo } from './package-yml-generator.js';
import { isPackageTransitivelyCovered } from '../../utils/dependency-coverage.js';
import { readPackageIndex, writePackageIndex } from '../../utils/package-index-yml.js';
import { createWorkspaceHash, createWorkspaceTag } from '../../utils/version-generator.js';
import { computeWipVersion, computePackTargetVersion } from './save-versioning.js';
import { savePackageToRegistry } from './package-saver.js';
import { packageVersionExists } from '../../utils/package-versioning.js';
import { deleteWorkspaceWipCopies } from './workspace-wip-cleanup.js';
import { writePackageYml } from '../../utils/package-yml.js';
import { formatRegistryPathForDisplay } from '../../utils/registry-paths.js';
import { resolveWorkspaceNames, SaveMode } from './name-resolution.js';
import { resolvePackageFilesWithConflicts } from './save-conflict-resolution.js';
import { detectPackageContext, getNoPackageDetectedMessage } from './package-detection.js';
import { applyWorkspacePackageRename } from './workspace-rename.js';
import { getLocalPackageDir } from '../../utils/paths.js';
import { FILE_PATTERNS } from '../../constants/index.js';

export { SaveMode } from './name-resolution.js';

export interface SavePipelineOptions {
  mode: SaveMode;
  force?: boolean;
  rename?: string;
}

export interface SavePipelineResult {
  config: { name: string; version: string };
  packageFiles: PackageFile[];
  syncResult: PlatformSyncResult;
}

export async function runSavePipeline(
  packageName: string | undefined,
  options: SavePipelineOptions
): Promise<CommandResult<SavePipelineResult>> {
  const cwd = process.cwd();
  const { mode, force, rename } = options;
  const { op, opCap } = MODE_LABELS[mode];

  const detectedContext = await detectPackageContext(cwd, packageName);
  if (!detectedContext) {
    return { success: false, error: getNoPackageDetectedMessage(packageName) };
  }

  await createWorkspacePackageYml(cwd);
  await ensureRegistryDirectories();

  const packageInput = packageName ?? detectedContext.config.name;
  const nameResolution = await resolveWorkspaceNames(packageInput, rename, mode);

  if (nameResolution.renameReason === 'scoping' && nameResolution.needsRename) {
    console.log(`✓ Using scoped package name '${nameResolution.finalName}' for ${op} operation`);
  }

  let packageInfo: PackageYmlInfo = {
    fullPath: detectedContext.packageYmlPath,
    config: detectedContext.config,
    isNewPackage: false,
    isRootPackage: detectedContext.isCwdPackage
  };

  if (nameResolution.needsRename) {
    await applyWorkspacePackageRename(cwd, packageInfo, nameResolution.finalName);

    const updatedFullPath = packageInfo.isRootPackage
      ? packageInfo.fullPath
      : join(
          getLocalPackageDir(cwd, nameResolution.finalName),
          FILE_PATTERNS.PACKAGE_YML
        );

    packageInfo = {
      ...packageInfo,
      fullPath: updatedFullPath,
      config: { ...packageInfo.config, name: nameResolution.finalName }
    };
  }

  const indexRecord = await readPackageIndex(cwd, packageInfo.config.name);
  const workspaceHash = createWorkspaceHash(cwd);
  const workspaceTag = createWorkspaceTag(cwd);

  let targetVersion: string;
  let shouldBumpPackageYml = false;
  let nextStable: string | undefined;

  if (mode === 'wip') {
    const wipInfo = computeWipVersion(
      packageInfo.config.version,
      indexRecord?.workspace?.version,
      cwd
    );
    if (wipInfo.resetMessage) console.log(wipInfo.resetMessage);
    targetVersion = wipInfo.wipVersion;
    shouldBumpPackageYml = wipInfo.shouldBumpPackageYml;
    nextStable = wipInfo.nextStable;
  } else {
    const packInfo = computePackTargetVersion(
      packageInfo.config.version,
      indexRecord?.workspace?.version
    );
    if (packInfo.resetMessage) console.log(packInfo.resetMessage);
    targetVersion = packInfo.targetVersion;
  }

  if (mode === 'wip' && shouldBumpPackageYml && nextStable) {
    try {
      const bumpedConfig = { ...packageInfo.config, version: nextStable };
      await writePackageYml(packageInfo.fullPath, bumpedConfig);
      packageInfo = { ...packageInfo, config: bumpedConfig };
      console.log(`✓ Updated package.yml.version to ${nextStable} for the next cycle`);
    } catch (error) {
      logger.warn(`Failed to auto-bump package.yml before save: ${String(error)}`);
    }
  }

  if (mode === 'stable' && !force) {
    const exists = await packageVersionExists(packageInfo.config.name, targetVersion);
    if (exists) {
      throw new Error(ERROR_MESSAGES.VERSION_EXISTS.replace('%s', targetVersion));
    }
  }

  const effectiveConfig = { ...packageInfo.config, version: targetVersion };
  const packageFiles = await resolvePackageFilesWithConflicts(packageInfo, { force });

  const registrySave = await savePackageToRegistry(
    { ...packageInfo, config: effectiveConfig },
    packageFiles
  );
  if (!registrySave.success) {
    return { success: false, error: registrySave.error || `${opCap} operation failed` };
  }

  await deleteWorkspaceWipCopies(
    effectiveConfig.name,
    workspaceTag,
    mode === 'wip' ? { keepVersion: targetVersion } : undefined
  );

  const syncResult = await performPlatformSync(
    cwd,
    effectiveConfig.name,
    effectiveConfig.version,
    packageFiles,
    {
      force,
      conflictStrategy: force ? 'overwrite' : 'ask',
      skipRootSync: packageInfo.isRootPackage
    }
  );

  if (!packageInfo.isRootPackage) {
    const covered = await isPackageTransitivelyCovered(cwd, effectiveConfig.name);
    if (!covered) {
      await addPackageToYml(cwd, effectiveConfig.name, effectiveConfig.version, false, undefined, true);
    } else {
      logger.debug(`Skipping addition of ${effectiveConfig.name} to package.yml; already covered transitively.`);
    }
  }

  if (mode === 'stable' && indexRecord) {
    await writePackageIndex({
      ...indexRecord,
      workspace: { hash: workspaceHash, version: effectiveConfig.version }
    });
  }

  printSummary(packageInfo, effectiveConfig.version, packageFiles, syncResult);

  return {
    success: true,
    data: { config: effectiveConfig, packageFiles, syncResult }
  };
}

function printSummary(
  packageInfo: PackageYmlInfo,
  version: string,
  packageFiles: PackageFile[],
  syncResult: PlatformSyncResult
): void {
  const name = packageInfo.config.name;
  const type = packageInfo.isRootPackage ? 'root package' : 'package';

  console.log(`${LOG_PREFIXES.SAVED} ${name}@${version} (${type}, ${packageFiles.length} files):`);

  if (packageFiles.length > 0) {
    for (const path of [...packageFiles.map(f => f.path)].sort()) {
      console.log(`   ├── ${formatRegistryPathForDisplay(path)}`);
    }
  }

  const printList = (label: string, files: string[]) => {
    if (files.length === 0) return;
    console.log(`✓ Platform sync ${label} ${files.length} files:`);
    for (const f of [...files].sort()) console.log(`   ├── ${f}`);
  };

  printList('created', syncResult.created);
  printList('updated', syncResult.updated);
  printList('removed', syncResult.deleted ?? []);
}


import { CommandResult, PackageFile } from '../../types/index.js';
import { ensureRegistryDirectories } from '../directory.js';
import { logger } from '../../utils/logger.js';
import { addPackageToYml, createWorkspacePackageYml } from '../../utils/package-management.js';
import { performPlatformSync, PlatformSyncResult } from '../sync/platform-sync.js';
import { LOG_PREFIXES, ERROR_MESSAGES, MODE_LABELS } from './constants.js';
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
import { 
  detectPackageContext, 
  getNoPackageDetectedMessage,
  getPackageYmlPath,
  getPackageFilesDir,
  getPackageRootDir,
  type PackageContext 
} from '../package-context.js';
import { applyWorkspacePackageRename } from './workspace-rename.js';

export type { SaveMode } from './name-resolution.js';

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

  // Use unified detection
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

  // Build PackageContext directly
  let packageContext: PackageContext = { ...detectedContext };

  if (nameResolution.needsRename) {
    await applyWorkspacePackageRename(cwd, packageContext, nameResolution.finalName);

    // For root packages, packageYmlPath stays the same
    // For nested packages, it moves to the new name's location
    const updatedPackageYmlPath = packageContext.location === 'root'
      ? packageContext.packageYmlPath
      : getPackageYmlPath(cwd, 'nested', nameResolution.finalName);
    
    const updatedPackageFilesDir = packageContext.location === 'root'
      ? packageContext.packageFilesDir
      : getPackageFilesDir(cwd, 'nested', nameResolution.finalName);

    const updatedPackageRootDir = packageContext.location === 'root'
      ? packageContext.packageRootDir
      : getPackageRootDir(cwd, 'nested', nameResolution.finalName);

    packageContext = {
      ...packageContext,
      name: nameResolution.finalName,
      packageYmlPath: updatedPackageYmlPath,
      packageFilesDir: updatedPackageFilesDir,
      packageRootDir: updatedPackageRootDir,
      config: { ...packageContext.config, name: nameResolution.finalName }
    };
  }

  const indexRecord = await readPackageIndex(cwd, packageContext.config.name, packageContext.location);
  const workspaceHash = createWorkspaceHash(cwd);
  const workspaceTag = createWorkspaceTag(cwd);

  let targetVersion: string;
  let shouldBumpPackageYml = false;
  let nextStable: string | undefined;

  if (mode === 'wip') {
    const wipInfo = computeWipVersion(
      packageContext.config.version,
      indexRecord?.workspace?.version,
      cwd
    );
    if (wipInfo.resetMessage) console.log(wipInfo.resetMessage);
    targetVersion = wipInfo.wipVersion;
    shouldBumpPackageYml = wipInfo.shouldBumpPackageYml;
    nextStable = wipInfo.nextStable;
  } else {
    const packInfo = computePackTargetVersion(
      packageContext.config.version,
      indexRecord?.workspace?.version
    );
    if (packInfo.resetMessage) console.log(packInfo.resetMessage);
    targetVersion = packInfo.targetVersion;
  }

  if (mode === 'wip' && shouldBumpPackageYml && nextStable) {
    try {
      const bumpedConfig = { ...packageContext.config, version: nextStable };
      await writePackageYml(packageContext.packageYmlPath, bumpedConfig);
      packageContext = { ...packageContext, config: bumpedConfig, version: nextStable };
      console.log(`✓ Updated package.yml.version to ${nextStable} for the next cycle`);
    } catch (error) {
      logger.warn(`Failed to auto-bump package.yml before save: ${String(error)}`);
    }
  }

  if (mode === 'stable' && !force) {
    const exists = await packageVersionExists(packageContext.config.name, targetVersion);
    if (exists) {
      throw new Error(ERROR_MESSAGES.VERSION_EXISTS.replace('%s', targetVersion));
    }
  }

  const effectiveConfig = { ...packageContext.config, version: targetVersion };
  const packageFiles = await resolvePackageFilesWithConflicts(packageContext, { force });

  const registrySave = await savePackageToRegistry(
    { ...packageContext, config: effectiveConfig },
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
      skipRootSync: packageContext.location === 'root',
      packageLocation: packageContext.location
    }
  );

  if (packageContext.location !== 'root') {
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

  printSummary(packageContext, effectiveConfig.version, packageFiles, syncResult);

  return {
    success: true,
    data: { config: effectiveConfig, packageFiles, syncResult }
  };
}

function printSummary(
  packageContext: PackageContext,
  version: string,
  packageFiles: PackageFile[],
  syncResult: PlatformSyncResult
): void {
  const name = packageContext.config.name;
  const type = packageContext.location === 'root' ? 'root package' : 'package';

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


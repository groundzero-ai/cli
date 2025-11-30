/**
 * Platform Sync Module
 * Utility functions for syncing saved package files across detected platforms
 */

import { getDetectedPlatforms } from '../platforms.js';
import { logger } from '../../utils/logger.js';
import type { PackageFile, InstallOptions } from '../../types/index.js';
import { syncRootFiles, type RootFileSyncResult } from './root-files-sync.js';
import { applyPlannedSyncForPackageFiles } from '../../utils/index-based-installer.js';

/**
 * Result of platform sync operation
 */
export interface PlatformSyncResult {
  created: string[];
  updated: string[];
  deleted?: string[];
}

export interface PlatformSyncOptions extends InstallOptions {
  skipRootSync?: boolean;
}

export async function performPlatformSync(
  cwd: string,
  packageName: string,
  packageVersion: string,
  packageFiles: PackageFile[],
  options: PlatformSyncOptions = {}
): Promise<PlatformSyncResult> {
  const { skipRootSync, ...installOptions } = options;
  const detectedPlatforms = await getDetectedPlatforms(cwd);

  logger.debug(
    `Planning platform sync for package ${packageName}@${packageVersion} across ${detectedPlatforms.length} platforms`
  );

  const syncOptions: InstallOptions = {
    ...installOptions,
    dryRun: installOptions?.dryRun ?? false,
    resolvedPlatforms: detectedPlatforms
  };

  const plannerOutcome = await applyPlannedSyncForPackageFiles(
    cwd,
    packageName,
    packageVersion,
    packageFiles,
    detectedPlatforms,
    syncOptions
  );

  const rootSyncResult: RootFileSyncResult = skipRootSync
    ? { created: [], updated: [], skipped: [] }
    : await syncRootFiles(cwd, packageFiles, packageName, detectedPlatforms);

  return {
    created: [...plannerOutcome.operation.installedFiles, ...rootSyncResult.created],
    updated: [...plannerOutcome.operation.updatedFiles, ...rootSyncResult.updated],
    deleted: plannerOutcome.operation.deletedFiles
  };
}
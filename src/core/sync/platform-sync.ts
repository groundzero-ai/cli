/**
 * Platform Sync Module
 * Utility functions for syncing saved formula files across detected platforms
 */

import { getDetectedPlatforms } from '../platforms.js';
import { logger } from '../../utils/logger.js';
import type { PackageFile, InstallOptions } from '../../types/index.js';
import { syncRootFiles } from './root-files-sync.js';
import { applyPlannedSyncForPackageFiles } from '../../utils/index-based-installer.js';

/**
 * Result of platform sync operation
 */
export interface PlatformSyncResult {
  created: string[];
  updated: string[];
  deleted?: string[];
}

export async function performPlatformSync(
  cwd: string,
  formulaName: string,
  formulaVersion: string,
  formulaFiles: PackageFile[],
  options: InstallOptions = {}
): Promise<PlatformSyncResult> {
  const detectedPlatforms = await getDetectedPlatforms(cwd);

  logger.debug(
    `Planning platform sync for formula ${formulaName}@${formulaVersion} across ${detectedPlatforms.length} platforms`
  );

  const syncOptions: InstallOptions = {
    ...options,
    dryRun: options?.dryRun ?? false,
    resolvedPlatforms: detectedPlatforms
  };

  const plannerOutcome = await applyPlannedSyncForPackageFiles(
    cwd,
    formulaName,
    formulaVersion,
    formulaFiles,
    detectedPlatforms,
    syncOptions
  );

  const rootSyncResult = await syncRootFiles(cwd, formulaFiles, formulaName, detectedPlatforms);

  return {
    created: [...plannerOutcome.operation.installedFiles, ...rootSyncResult.created],
    updated: [...plannerOutcome.operation.updatedFiles, ...rootSyncResult.updated],
    deleted: plannerOutcome.operation.deletedFiles
  };
}
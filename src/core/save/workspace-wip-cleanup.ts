import { remove } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { extractWorkspaceHashFromVersion } from '../../utils/version-generator.js';
import { getPackageVersionPath, listPackageVersions } from '../directory.js';

interface CleanupOptions {
  keepVersion?: string;
}

/**
 * Remove WIP versions for the current workspace from the local registry.
 * Returns the number of versions removed.
 */
export async function deleteWorkspaceWipCopies(
  packageName: string,
  workspaceHash: string,
  options: CleanupOptions = {}
): Promise<number> {
  const normalizedHash = workspaceHash.toLowerCase();
  const versions = await listPackageVersions(packageName);
  let deletedCount = 0;

  for (const version of versions) {
    if (options.keepVersion && version === options.keepVersion) {
      continue;
    }

    const versionHash = extractWorkspaceHashFromVersion(version);
    if (!versionHash || versionHash.toLowerCase() !== normalizedHash) {
      continue;
    }

    const versionPath = getPackageVersionPath(packageName, version);
    try {
      await remove(versionPath);
      deletedCount++;
      logger.debug(`Removed workspace WIP copy`, { packageName, version, versionPath });
    } catch (error) {
      logger.warn(`Failed to remove workspace WIP copy ${packageName}@${version}: ${error}`);
    }
  }

  return deletedCount;
}


import { PackageFile, PackageYml } from '../../types';
import { normalizePackageName } from '../../utils/package-name.js';
import { remove } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { getPackageVersionPath } from '../directory.js';
import { PackageYmlInfo } from './package-yml-generator.js';
import { packageVersionExists } from '../../utils/package-versioning.js';
import { writePackageFilesToDirectory } from '../../utils/package-copy.js';

/**
 * Save package to local registry
 */
export async function savePackageToRegistry(
  packageInfo: PackageYmlInfo,
  files: PackageFile[]
): Promise<{ success: boolean; error?: string; updatedConfig?: PackageYml }> {

  const config = packageInfo.config;

  try {
    // Ensure package name is normalized for consistent registry paths
    const normalizedConfig = { ...config, name: normalizePackageName(config.name) };
    const targetPath = getPackageVersionPath(normalizedConfig.name, normalizedConfig.version);

    // If version already exists, clear the directory first to remove old files
    if (await packageVersionExists(normalizedConfig.name, normalizedConfig.version)) {
      await remove(targetPath);
      logger.debug(`Cleared existing version directory: ${targetPath}`);
    }

    await writePackageFilesToDirectory(targetPath, files);
    
    return { success: true, updatedConfig: normalizedConfig };
  } catch (error) {
    logger.error(`Failed to save package: ${error}`);
    return { success: false, error: `Failed to save package: ${error}` };
  }
}

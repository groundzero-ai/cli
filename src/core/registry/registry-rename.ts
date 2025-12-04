import { join } from 'path';
import { getPackagePath } from '../directory.js';
import { exists, listDirectories, renameDirectory } from '../../utils/fs.js';
import { parsePackageYml, writePackageYml } from '../../utils/package-yml.js';
import { logger } from '../../utils/logger.js';
import { PACKAGE_PATHS } from '../../constants/index.js';

/**
 * Rename a package directory inside the local registry and update metadata.
 */
export async function renameRegistryPackage(oldName: string, newName: string): Promise<void> {
  if (oldName === newName) {
    return;
  }

  const oldPath = getPackagePath(oldName);
  const newPath = getPackagePath(newName);

  if (!(await exists(oldPath))) {
    throw new Error(`Cannot rename registry package '${oldName}': path not found (${oldPath})`);
  }

  if (await exists(newPath)) {
    throw new Error(`Cannot rename registry package to '${newName}': target already exists (${newPath})`);
  }

  logger.debug('Renaming registry package', { from: oldName, to: newName, oldPath, newPath });
  await renameDirectory(oldPath, newPath);

  const versionDirs = await listDirectories(newPath);
  for (const version of versionDirs) {
    const packageYmlPath = join(
      newPath,
      version,
      PACKAGE_PATHS.MANIFEST_RELATIVE
    );
    if (!(await exists(packageYmlPath))) {
      continue;
    }

    try {
      const config = await parsePackageYml(packageYmlPath);
      if (config.name !== newName) {
        config.name = newName;
        await writePackageYml(packageYmlPath, config);
      }
    } catch (error) {
      logger.warn(`Failed to update package name in ${packageYmlPath}: ${String(error)}`);
    }
  }
}


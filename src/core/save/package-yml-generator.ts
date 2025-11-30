import { join } from 'path';

import { FILE_PATTERNS } from '../../constants/index.js';
import { PackageYml } from '../../types/index.js';
import { normalizePackageName } from '../../utils/package-name.js';
import { writePackageYml } from '../../utils/package-yml.js';
import { logger } from '../../utils/logger.js';
import { getLocalPackageDir } from '../../utils/paths.js';
import { ensurePackageWithYml } from '../../utils/package-management.js';
import { DEFAULT_VERSION, LOG_PREFIXES } from './constants.js';
import { applyWorkspacePackageRename } from './workspace-rename.js';

export type PackageYmlInfo = {
  fullPath: string;
  config: PackageYml;
  isNewPackage: boolean;
  isRootPackage: boolean;
};

export interface LoadPackageOptions {
  renameTo?: string;
}

export async function readOrCreateBasePackageYml(
  cwd: string,
  name: string
): Promise<PackageYmlInfo> {
  const normalizedName = normalizePackageName(name);
  const ensured = await ensurePackageWithYml(cwd, normalizedName, {
    defaultVersion: DEFAULT_VERSION
  });

  if (ensured.isNew) {
    logger.debug('No package.yml found for save, creating', { dir: ensured.packageDir });
    console.log(`${LOG_PREFIXES.CREATED} ${ensured.packageDir}`);
    console.log(`${LOG_PREFIXES.NAME} ${ensured.packageConfig.name}`);
    console.log(`${LOG_PREFIXES.VERSION} ${ensured.packageConfig.version}`);
  } else {
    logger.debug('Found existing package.yml for save', { path: ensured.packageYmlPath });
    console.log(`✓ Found existing package ${ensured.packageConfig.name}@${ensured.packageConfig.version}`);
  }

  return {
    fullPath: ensured.packageYmlPath,
    config: ensured.packageConfig,
    isNewPackage: ensured.isNew,
    isRootPackage: false
  };
}

export async function loadAndPreparePackage(
  cwd: string,
  packageName: string,
  options: LoadPackageOptions = {}
): Promise<PackageYmlInfo> {
  const renameTarget = options.renameTo ? normalizePackageName(options.renameTo) : undefined;
  const info = await readOrCreateBasePackageYml(cwd, packageName);

  if (!renameTarget || renameTarget === info.config.name) {
    return info;
  }

  logger.debug(`Renaming package during workspace load`, {
    from: info.config.name,
    to: renameTarget
  });

  await applyWorkspacePackageRename(cwd, info, renameTarget);

  const targetDir = getLocalPackageDir(cwd, renameTarget);
  const packageYmlPath = join(targetDir, FILE_PATTERNS.PACKAGE_YML);

  return {
    ...info,
    fullPath: packageYmlPath,
    config: { ...info.config, name: renameTarget }
  };
}

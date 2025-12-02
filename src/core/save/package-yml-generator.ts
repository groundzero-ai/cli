import { dirname } from 'path';
import { normalizePackageName } from '../../utils/package-name.js';
import { logger } from '../../utils/logger.js';
import { getPackageFilesDir, getPackageYmlPath, getPackageRootDir, type PackageContext } from '../package-context.js';
import { ensurePackageWithYml } from '../../utils/package-management.js';
import { DEFAULT_VERSION, LOG_PREFIXES } from './constants.js';
import { applyWorkspacePackageRename } from './workspace-rename.js';

export interface LoadPackageOptions {
  renameTo?: string;
}

export async function readOrCreateBasePackageYml(
  cwd: string,
  name: string
): Promise<PackageContext> {
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

  // ensured.packageDir is the content directory (.openpackage/), so package root is parent
  const packageRootDir = dirname(ensured.packageDir);
  
  return {
    name: ensured.normalizedName,
    version: ensured.packageConfig.version,
    config: ensured.packageConfig,
    packageYmlPath: ensured.packageYmlPath,
    packageRootDir,
    packageFilesDir: ensured.packageDir,
    location: 'nested',
    isCwdPackage: false,
    isNew: ensured.isNew
  };
}

export async function loadAndPreparePackage(
  cwd: string,
  packageName: string,
  options: LoadPackageOptions = {}
): Promise<PackageContext> {
  const renameTarget = options.renameTo ? normalizePackageName(options.renameTo) : undefined;
  const ctx = await readOrCreateBasePackageYml(cwd, packageName);

  if (!renameTarget || renameTarget === ctx.config.name) {
    return ctx;
  }

  logger.debug(`Renaming package during workspace load`, {
    from: ctx.config.name,
    to: renameTarget
  });

  await applyWorkspacePackageRename(cwd, ctx, renameTarget);

  const packageRootDir = getPackageRootDir(cwd, 'nested', renameTarget);
  const packageYmlPath = getPackageYmlPath(cwd, 'nested', renameTarget);
  const packageFilesDir = getPackageFilesDir(cwd, 'nested', renameTarget);

  return {
    ...ctx,
    name: renameTarget,
    packageYmlPath,
    packageRootDir,
    packageFilesDir,
    config: { ...ctx.config, name: renameTarget }
  };
}

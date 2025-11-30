import { join, dirname, relative } from 'path';
import { InstallOptions } from '../types/index.js';
import { DEFAULT_INSTALL_ROOT } from '../constants/workspace.js';
import { logger } from './logger.js';
import { packageManager } from '../core/package.js';
import { exists, ensureDir, writeTextFile } from './fs.js';

/**
 * Install package files to the workspace install root directory
 * @param packageName - Name of the package to install
 * @param targetDir - Target directory for installation
 * @param options - Installation options including force and dry-run flags
 * @param version - Specific version to install (optional)
 * @param forceOverwrite - Force overwrite existing files
 * @returns Object containing installation results including file counts and status flags
 */
export async function installWorkspaceFiles(
  packageName: string,
  targetDir: string,
  options: InstallOptions,
  version?: string,
  forceOverwrite?: boolean
): Promise<{ installedCount: number; files: string[]; overwritten: boolean; skipped: boolean }> {
  logger.debug(`Installing workspace files for ${packageName} to ${targetDir}`, { version, forceOverwrite });

  try {
    // Get package from registry
    const pkg = await packageManager.loadPackage(packageName, version);

    // Only install files that live under the workspace install root prefix
    const installRootPrefix = `${DEFAULT_INSTALL_ROOT}/`;
    const filesToInstall = pkg.files.filter(file => file.path.startsWith(installRootPrefix))

    if (filesToInstall.length === 0) {
      logger.debug(`No workspace files to install for ${packageName}@${version || 'latest'}`);
      return { installedCount: 0, files: [], overwritten: false, skipped: true };
    }

    // Check for existing files in parallel, rebasing paths under <installRoot>/<targetDir>/...
    const existenceChecks = await Promise.all(
      filesToInstall.map(async (file) => {
        const installRelPath = file.path.slice(installRootPrefix.length);
        const targetPath = join(DEFAULT_INSTALL_ROOT, targetDir || '.', installRelPath);
        const fileExists = await exists(targetPath);
        return { file, targetPath, exists: fileExists };
      })
    );

    const conflicts = existenceChecks.filter(item => item.exists);
    const hasOverwritten = conflicts.length > 0 && (options.force === true || forceOverwrite === true);

    // Handle conflicts - skip if files exist and no force flag
    if (conflicts.length > 0 && options.force !== true && forceOverwrite !== true) {
      logger.debug(`Skipping ${packageName} - files would be overwritten: ${conflicts.map(c => c.targetPath).join(', ')}`);
      return { installedCount: 0, files: [], overwritten: false, skipped: true };
    }

    // Pre-create all necessary directories
    const directories = new Set<string>();
    for (const { targetPath } of existenceChecks) {
      directories.add(dirname(targetPath));
    }

    // Create all directories in parallel
    await Promise.all(Array.from(directories).map(dir => ensureDir(dir)));

    // Install files in parallel
    const installedFiles: string[] = [];
    const installPromises = existenceChecks.map(async ({ file, targetPath }) => {
      await writeTextFile(targetPath, file.content);
      installedFiles.push(targetPath);
      logger.debug(`Installed workspace file: ${targetPath}`);
    });

    await Promise.all(installPromises);

    logger.info(`Successfully installed ${installedFiles.length} workspace files for ${packageName}@${version || 'latest'}`);

    return {
      installedCount: installedFiles.length,
      files: installedFiles,
      overwritten: hasOverwritten,
      skipped: false
    };

  } catch (error) {
    logger.error(`Failed to install workspace files for package ${packageName}: ${error}`);
    return {
      installedCount: 0,
      files: [],
      overwritten: false,
      skipped: true
    };
  }
}

/**
 * Install workspace files from a pre-filtered list of package files (avoids re-loading registry)
 */
export async function installWorkspaceFilesFromList(
  cwd: string,
  targetDir: string,
  files: { path: string; content: string }[],
  options: InstallOptions,
  forceOverwrite: boolean = false
): Promise<{ installedCount: number; files: string[]; overwritten: boolean; skipped: boolean }> {
  try {
    if (files.length === 0) {
      return { installedCount: 0, files: [], overwritten: false, skipped: true };
    }

    const installRootPrefix = `${DEFAULT_INSTALL_ROOT}/`;

    // Pre-create dirs
    const directories = new Set<string>();
    const targets = await Promise.all(files.map(async (file) => {
      const installRelPath = file.path.startsWith(installRootPrefix) ? file.path.slice(installRootPrefix.length) : file.path;
      const targetPath = join(DEFAULT_INSTALL_ROOT, targetDir || '.', installRelPath);
      directories.add(dirname(targetPath));
      const existsFlag = await exists(targetPath);
      return { file, targetPath, existsFlag };
    }));

    const hasOverwritten = targets.some(t => t.existsFlag) && (options.force === true || forceOverwrite === true);

    // Skip if conflicts and not forced
    if (targets.some(t => t.existsFlag) && !hasOverwritten) {
      return { installedCount: 0, files: [], overwritten: false, skipped: true };
    }

    await Promise.all(Array.from(directories).map(d => ensureDir(d)));

    const installedFiles: string[] = [];
    await Promise.all(targets.map(async ({ file, targetPath }) => {
      await writeTextFile(targetPath, file.content);
      installedFiles.push(targetPath);
      logger.debug(`Installed workspace file: ${targetPath}`);
    }));

    return { installedCount: installedFiles.length, files: installedFiles, overwritten: hasOverwritten, skipped: false };
  } catch (error) {
    logger.error(`Failed to install workspace files from list: ${error}`);
    return { installedCount: 0, files: [], overwritten: false, skipped: true };
  }
}

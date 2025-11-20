import { join, dirname, relative } from 'path';
import { InstallOptions } from '../types/index.js';
import { PLATFORM_DIRS } from '../constants/index.js';
import { logger } from './logger.js';
import { packageManager } from '../core/package.js';
import { exists, ensureDir, writeTextFile } from './fs.js';

/**
 * Install formula files to ai directory
 * @param formulaName - Name of the formula to install
 * @param targetDir - Target directory for installation
 * @param options - Installation options including force and dry-run flags
 * @param version - Specific version to install (optional)
 * @param forceOverwrite - Force overwrite existing files
 * @returns Object containing installation results including file counts and status flags
 */
export async function installAiFiles(
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  version?: string,
  forceOverwrite?: boolean
): Promise<{ installedCount: number; files: string[]; overwritten: boolean; skipped: boolean }> {
  logger.debug(`Installing AI directory files for ${formulaName} to ${targetDir}`, { version, forceOverwrite });

  try {
    // Get formula from registry
    const formula = await packageManager.loadPackage(formulaName, version);

    // Filter to only install AI directory files (those starting with ai/) - allow all file types
    const aiPrefix = `${PLATFORM_DIRS.AI}/`;
    const filesToInstall = formula.files.filter(file => file.path.startsWith(aiPrefix))

    if (filesToInstall.length === 0) {
      logger.debug(`No AI directory files to install for ${formulaName}@${version || 'latest'}`);
      return { installedCount: 0, files: [], overwritten: false, skipped: true };
    }

    // Check for existing files in parallel, rebasing paths under ai/<targetDir>/...
    const existenceChecks = await Promise.all(
      filesToInstall.map(async (file) => {
        const aiRelPath = file.path.slice(aiPrefix.length); // strip "ai/"
        const targetPath = join(PLATFORM_DIRS.AI, targetDir || '.', aiRelPath);
        const fileExists = await exists(targetPath);
        return { file, targetPath, exists: fileExists };
      })
    );

    const conflicts = existenceChecks.filter(item => item.exists);
    const hasOverwritten = conflicts.length > 0 && (options.force === true || forceOverwrite === true);

    // Handle conflicts - skip if files exist and no force flag
    if (conflicts.length > 0 && options.force !== true && forceOverwrite !== true) {
      logger.debug(`Skipping ${formulaName} - files would be overwritten: ${conflicts.map(c => c.targetPath).join(', ')}`);
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
      logger.debug(`Installed AI file: ${targetPath}`);
    });

    await Promise.all(installPromises);

    logger.info(`Successfully installed ${installedFiles.length} AI directory files for ${formulaName}@${version || 'latest'}`);

    return {
      installedCount: installedFiles.length,
      files: installedFiles,
      overwritten: hasOverwritten,
      skipped: false
    };

  } catch (error) {
    logger.error(`Failed to install AI files for formula ${formulaName}: ${error}`);
    return {
      installedCount: 0,
      files: [],
      overwritten: false,
      skipped: true
    };
  }
}

/**
 * Install AI files from a pre-filtered list of formula files (avoids re-loading registry)
 */
export async function installAiFilesFromList(
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

    const aiPrefix = `${PLATFORM_DIRS.AI}/`;

    // Pre-create dirs
    const directories = new Set<string>();
    const targets = await Promise.all(files.map(async (file) => {
      const aiRelPath = file.path.startsWith(aiPrefix) ? file.path.slice(aiPrefix.length) : file.path;
      const targetPath = join(PLATFORM_DIRS.AI, targetDir || '.', aiRelPath);
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
      logger.debug(`Installed AI file: ${targetPath}`);
    }));

    return { installedCount: installedFiles.length, files: installedFiles, overwritten: hasOverwritten, skipped: false };
  } catch (error) {
    logger.error(`Failed to install AI files from list: ${error}`);
    return { installedCount: 0, files: [], overwritten: false, skipped: true };
  }
}

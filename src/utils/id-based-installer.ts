/**
 * ID-based Installer
 * Handles installation of platform-specific markdown files using ID-based matching
 * instead of path-based matching, allowing custom file organization in cwd.
 */

import { join, dirname, relative } from 'path';
import { exists, ensureDir, writeTextFile, remove } from './fs.js';
import { logger } from './logger.js';
import { getFirstPathComponent, getPathAfterFirstComponent } from './path-normalization.js';
import { getPlatformDefinition } from '../core/platforms.js';
import { UNIVERSAL_SUBDIRS, type Platform } from '../constants/index.js';
import type { FormulaFile, InstallOptions } from '../types/index.js';
import {
  buildCwdIdMap,
  buildRegistryIdMap,
  resolveInstallPathFromAdjacent,
  cleanupInvalidFormulaFiles,
  type RegistryFileInfo,
  CwdIdMapEntry
} from './id-based-discovery.js';
import { getPlatformSpecificFilename, parseUniversalPath } from './platform-file.js';
import { mergePlatformYamlOverride } from './platform-yaml-merge.js';
import { loadRegistryYamlOverrides } from './id-based-discovery.js';

/**
 * Result of ID-based installation
 */
export interface IdBasedInstallResult {
  installed: number;
  updated: number;
  renamed: number;
  cleaned: number;
  deleted: number;
  skipped: number;
  files: string[];
  installedFiles: string[];
  updatedFiles: string[];
}

/**
 * Install platform-specific markdown files using ID-based matching
 * 
 * Algorithm:
 * 1. Build ID maps for cwd and registry
 * 2. Clean up invalid files in cwd
 * 3. Process registry files:
 *    - Files with matching IDs → update/overwrite at cwd location (including rename if needed)
 *    - New files → find adjacent files and install to same directory, or use registry path
 */
export async function installPlatformFilesById(
  cwd: string,
  formulaName: string,
  version: string,
  platforms: Platform[],
  options: InstallOptions,
  forceOverwrite: boolean = false
): Promise<IdBasedInstallResult> {
  const result: IdBasedInstallResult = {
    installed: 0,
    updated: 0,
    renamed: 0,
    cleaned: 0,
    deleted: 0,
    skipped: 0,
    files: [],
    installedFiles: [],
    updatedFiles: []
  };

  logger.debug(`Installing platform files by ID for ${formulaName}@${version}`, {
    platforms,
    forceOverwrite
  });

  // Load YAML overrides once per install (used lazily per platform)
  const yamlOverrides = await loadRegistryYamlOverrides(formulaName, version);

  // Step 1: Build cwd ID map
  const cwdIdMap = await buildCwdIdMap(cwd, platforms, formulaName);
  logger.debug(`Found ${Array.from(cwdIdMap.values()).reduce((sum, arr) => sum + arr.length, 0)} files with valid IDs in cwd`);

  // Step 2: Build registry ID map
  const registryIdMap = await buildRegistryIdMap(formulaName, version);
  logger.debug(`Found ${registryIdMap.size} platform files in registry`);

  // Step 3: Clean up invalid files in cwd
  const cleanupResult = await cleanupInvalidFormulaFiles(cwd, platforms, formulaName, registryIdMap);
  result.cleaned = cleanupResult.cleaned.length;
  result.deleted = cleanupResult.deleted.length;
  
  if (cleanupResult.cleaned.length > 0) {
    logger.info(`Cleaned ${cleanupResult.cleaned.length} files with invalid frontmatter`);
  }
  if (cleanupResult.deleted.length > 0) {
    logger.info(`Deleted ${cleanupResult.deleted.length} orphaned files`);
  }

  // Step 4: Process each platform separately
  for (const platform of platforms) {
    // Batch registry files by parent directory for this platform
    const filesByDir = new Map<string, RegistryFileInfo[]>();
    for (const [, fileInfo] of registryIdMap) {
      const parentDir = fileInfo.parentDir;
      if (!filesByDir.has(parentDir)) {
        filesByDir.set(parentDir, []);
      }
      filesByDir.get(parentDir)!.push(fileInfo);
    }

    // Step 5: Process each batch for this platform
    for (const [parentDir, files] of filesByDir) {
      await processBatchOfFilesForPlatform(
        cwd,
        platform,
        parentDir,
        files,
        cwdIdMap,
        options,
        forceOverwrite,
        result,
        yamlOverrides
      );
    }
  }

  logger.info(`ID-based installation complete: ${result.installed} installed, ${result.updated} updated, ${result.renamed} renamed, ${result.skipped} skipped`);

  return result;
}

/**
 * Process a batch of files from the same parent directory in the registry for a specific platform
 */
async function processBatchOfFilesForPlatform(
  cwd: string,
  platform: Platform,
  parentDir: string,
  files: RegistryFileInfo[],
  cwdIdMap: Map<string, CwdIdMapEntry[]>,
  options: InstallOptions,
  forceOverwrite: boolean,
  result: IdBasedInstallResult,
  yamlOverrides: FormulaFile[]
): Promise<void> {
  // Separate files into those with matching IDs and new files
  const matchingFiles: RegistryFileInfo[] = [];
  const newFiles: RegistryFileInfo[] = [];

  for (const file of files) {
    logger.debug(`Processing file ${file.fileName} with ID: ${file.id} for platform ${platform}`);

    // Check if ID exists in this specific platform only
    const cwdEntries = file.id ? cwdIdMap.get(file.id) : null;
    logger.debug(`cwdEntries: ${JSON.stringify(cwdEntries)}`);
    const existsInPlatform = cwdEntries?.some(entry => entry.platform === platform) ?? false;

    if (file.id && existsInPlatform) {
      logger.debug(`Found matching ID ${file.id} in platform ${platform} - treating as matching file`);
      matchingFiles.push(file);
    } else {
      logger.debug(`No matching ID ${file.id} in platform ${platform} - treating as new file`);
      logger.debug(`Available IDs in platform ${platform}: ${cwdEntries?.filter(e => e.platform === platform).map(e => e.id).join(', ') || 'none'}`);
      newFiles.push(file);
    }
  }

  // Process matching files (update/overwrite at current cwd location)
  for (const file of matchingFiles) {
    await processMatchingFileForPlatform(file, platform, cwdIdMap, options, forceOverwrite, result, cwd, yamlOverrides);
  }

  // Process new files (install to adjacent file location or use registry path)
  if (newFiles.length > 0) {
    await processNewFilesForPlatform(cwd, platform, parentDir, newFiles, cwdIdMap, options, result, yamlOverrides);
  }
}

/**
 * Process a file that has a matching ID in cwd for a specific platform
 * Updates content and renames file if registry filename differs
 * Only processes the single matching file found in cwd for this platform
 */
async function processMatchingFileForPlatform(
  registryFile: RegistryFileInfo,
  platform: Platform,
  cwdIdMap: Map<string, CwdIdMapEntry[]>,
  options: InstallOptions,
  forceOverwrite: boolean,
  result: IdBasedInstallResult,
  cwd: string,
  yamlOverrides: FormulaFile[]
): Promise<void> {
  const cwdEntries = cwdIdMap.get(registryFile.id!);
  if (!cwdEntries || cwdEntries.length === 0) return;

  // Filter to entries for this specific platform only
  const platformEntries = cwdEntries.filter(entry => entry.platform === platform);
  if (platformEntries.length === 0) return;

  // Update entries for this ID in this platform only
  for (const cwdEntry of platformEntries) {
    const currentPath = cwdEntry.fullPath;
    const currentFileName = cwdEntry.fileName;
    const platformSpecificFileName = getPlatformSpecificFilename(registryFile.registryPath, platform);

    // Check if filename needs to be updated
    const needsRename = currentFileName !== platformSpecificFileName;
    const targetPath = needsRename
      ? join(dirname(currentPath), platformSpecificFileName)
      : currentPath;

  // Check if target path already exists (for rename case)
    if (needsRename && (await exists(targetPath))) {
      if (!forceOverwrite && !options.force) {
        logger.warn(`Cannot rename ${currentFileName} to ${platformSpecificFileName}: target exists`);
        result.skipped++;
        continue;
      }
      // Delete existing target file before rename
      await remove(targetPath);
    }

  try {
    // Merge platform YAML override if present for this platform and path
    const parsedUniversal = parseUniversalPath(registryFile.registryPath);
    const mergedContent = parsedUniversal
      ? mergePlatformYamlOverride(
          registryFile.content,
          platform,
          parsedUniversal.universalSubdir,
          parsedUniversal.relPath,
          yamlOverrides
        )
      : registryFile.content;

    // Write updated content
    await writeTextFile(currentPath, mergedContent);
    
    // Rename if needed
    if (needsRename) {
      // Use fs.rename via dynamic import since renameDirectory is for directories
      const { rename } = await import('fs/promises');
      await rename(currentPath, targetPath);
      result.renamed++;
      logger.debug(`Renamed and updated ${currentFileName} → ${platformSpecificFileName}`);
    }
    
    result.updated++;
    const relativePath = relative(cwd, targetPath);
    result.files.push(relativePath);
    result.updatedFiles.push(relativePath);
    } catch (error) {
      logger.error(`Failed to update file ${currentPath}: ${error}`);
      result.skipped++;
    }
  }
}

/**
 * Process new files (those without matching IDs in cwd) for a specific platform
 * Installs to the specified platform, attempting to install near adjacent files or using registry path structure
 */
async function processNewFilesForPlatform(
  cwd: string,
  platform: Platform,
  registryParentDir: string,
  files: RegistryFileInfo[],
  cwdIdMap: Map<string, CwdIdMapEntry[]>,
  options: InstallOptions,
  result: IdBasedInstallResult,
  yamlOverrides: FormulaFile[]
): Promise<void> {
  // Collect all adjacent IDs from these files
  const allAdjacentIds = new Set<string>();
  for (const file of files) {
    for (const id of file.adjacentIds) {
      if (id !== file.id) {
        allAdjacentIds.add(id);
      }
    }
  }

  // Try to find a directory in cwd based on adjacent files
  const resolvedDir = await resolveInstallPathFromAdjacent(
    Array.from(allAdjacentIds),
    cwdIdMap
  );

  // Determine target directory for this platform
  let targetDir: string | null;

  if (resolvedDir) {
    // Found adjacent files - use their directory
    targetDir = resolvedDir;
    logger.debug(`Installing ${files.length} new files to ${targetDir} for platform ${platform} (adjacent files found)`);
  } else {
    // No adjacent files - map registry path to this platform's directory
    targetDir = await mapRegistryPathToCwd(cwd, [platform], registryParentDir);

    if (targetDir === null) {
      // Platform doesn't support this universal subdirectory
      const universalSubdir = getFirstPathComponent(registryParentDir);
      console.log(`⚠️  Skipping ${files.length} files in ${universalSubdir}/ - ${platform} platform does not support ${universalSubdir} subdirectory`);
      logger.debug(`Platform ${platform} does not support universal subdirectory: ${universalSubdir}`);
      return; // Skip processing this batch
    }

    logger.debug(`Installing ${files.length} new files to ${targetDir} for platform ${platform} (using registry path)`);
  }

  // Install each file to this platform
  for (const file of files) {
    await installNewFile(cwd, targetDir, file, platform, options, result, yamlOverrides);
  }
}

/**
 * Map a registry parent directory path to a cwd platform directory
 * E.g., "rules/subdir" → ".cursor/rules/subdir" (for first available platform)
 * Returns null if the platform doesn't support the universal subdirectory
 */
async function mapRegistryPathToCwd(
  cwd: string,
  platforms: Platform[],
  registryParentDir: string
): Promise<string | null> {
  // Extract the universal subdir and relative path
  const universalSubdir = getFirstPathComponent(registryParentDir) as typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS];
  const relativePath = getPathAfterFirstComponent(registryParentDir);

  // Use the first platform to determine the target directory
  const platform = platforms[0];
  const platformDef = getPlatformDefinition(platform);
  const subdirDef = platformDef.subdirs[universalSubdir];

  if (!subdirDef) {
    // Platform doesn't support this universal subdirectory
    return null;
  }

  const baseDir = join(cwd, platformDef.rootDir, subdirDef.path);
  return relativePath ? join(baseDir, relativePath) : baseDir;
}

/**
 * Install a new file to the target directory
 */
async function installNewFile(
  cwd: string,
  targetDir: string,
  file: RegistryFileInfo,
  platform: Platform,
  options: InstallOptions,
  result: IdBasedInstallResult,
  yamlOverrides: FormulaFile[]
): Promise<void> {
  const platformSpecificFileName = getPlatformSpecificFilename(file.registryPath, platform);
  const targetPath = join(targetDir, platformSpecificFileName);

  // Check if file already exists
  if (await exists(targetPath)) {
    if (!options.force) {
      console.log(`Skipping ${platformSpecificFileName} - already exists at ${targetPath}`);
      result.skipped++;
      return;
    }
  }

  try {
    // Ensure directory exists
    await ensureDir(targetDir);

    // Merge platform YAML override if present
    const parsedUniversal = parseUniversalPath(file.registryPath);
    const mergedContent = parsedUniversal
      ? mergePlatformYamlOverride(
          file.content,
          platform,
          parsedUniversal.universalSubdir,
          parsedUniversal.relPath,
          yamlOverrides
        )
      : file.content;

    // Write file
    await writeTextFile(targetPath, mergedContent);
    
    result.installed++;
    const relativePath = relative(cwd, targetPath);
    result.files.push(relativePath);
    result.installedFiles.push(relativePath);
    logger.debug(`Installed new file ${platformSpecificFileName} to ${targetPath}`);
  } catch (error) {
    logger.error(`Failed to install ${platformSpecificFileName}: ${error}`);
    result.skipped++;
  }
}


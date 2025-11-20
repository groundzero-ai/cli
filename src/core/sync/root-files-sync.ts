/**
 * Root File Sync Module
 * Utility functions for syncing saved root package files across detected platforms
 */

import { relative } from 'path';
import { ensureDir, writeTextFile, exists, readTextFile } from '../../utils/fs.js';
import { getPlatformDefinition, getAllPlatforms } from '../platforms.js';
import { type Platform, FILE_PATTERNS } from '../../constants/index.js';
import { logger } from '../../utils/logger.js';
import type { PackageFile } from '../../types/index.js';
import { mergePackageContentIntoRootFile } from '../../utils/root-file-merger.js';
import { getPathLeaf } from '../../utils/path-normalization.js';
import { getPlatformForRootFile } from '../../utils/root-file-registry.js';
import { extractPackageContentFromRootFile } from '../../utils/root-file-extractor.js';

/**
 * Result of root file sync operation
 */
export interface RootFileSyncResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

/**
 * Sync saved root package files across all detected platforms
 * Converts between platform-specific root files (e.g., CLAUDE.md ↔ AGENTS.md)
 * @param cwd - Current working directory
 * @param packageFiles - Array of package files that were saved to registry
 * @param packageName - Name of the package being synced
 * @param platforms - Array of platforms to sync files to
 * @returns Promise resolving to sync result with created, updated, and skipped files
 */
export async function syncRootFiles(
  cwd: string,
  packageFiles: PackageFile[],
  packageName: string,
  platforms: Platform[]
): Promise<RootFileSyncResult> {
  const result: RootFileSyncResult = {
    created: [],
    updated: [],
    skipped: []
  };

  if (platforms.length === 0) {
    logger.debug('No platforms provided, skipping root file sync');
    return result;
  }

  // Filter package files to only root files
  const rootFiles = packageFiles.filter(file => isRootFile(file.path));

  if (rootFiles.length === 0) {
    logger.debug('No root files found in package, skipping root file sync');
    return result;
  }

  logger.debug(`Starting root file sync for ${rootFiles.length} files across ${platforms.length} platforms`);

  // Process each root file
  for (const rootFile of rootFiles) {
    try {
      const syncResults = await syncSingleRootFile(cwd, rootFile, packageName, platforms);
      result.created.push(...syncResults.created);
      result.updated.push(...syncResults.updated);
      result.skipped.push(...syncResults.skipped);
    } catch (error) {
      logger.warn(`Failed to sync root file ${rootFile.path}: ${error}`);
      result.skipped.push(rootFile.path);
    }
  }

  // Deduplicate results (multiple root files may sync to the same target file)
  result.created = Array.from(new Set(result.created));
  result.updated = Array.from(new Set(result.updated));
  result.skipped = Array.from(new Set(result.skipped));

  return result;
}

/**
 * Check if a file path represents a root file
 */
export function isRootFile(filePath: string): boolean {
  // Get all possible root file names from platform definitions
  const rootFileNames = new Set<string>();
  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) {
      rootFileNames.add(def.rootFile);
    }
  }
  // Also treat universal root file as a root file
  rootFileNames.add(FILE_PATTERNS.AGENTS_MD);

  const fileName = getPathLeaf(filePath);
  return fileName ? rootFileNames.has(fileName) : false;
}

/**
 * Sync a single root file across detected platforms
 */
async function syncSingleRootFile(
  cwd: string,
  rootFile: PackageFile,
  packageName: string,
  detectedPlatforms: Platform[]
): Promise<RootFileSyncResult> {
  const result: RootFileSyncResult = {
    created: [],
    updated: [],
    skipped: []
  };

  const sourceFileName = getPathLeaf(rootFile.path);
  const sectionBody = rootFile.content.trim();
  if (!sectionBody) {
    logger.warn(`Empty section for ${sourceFileName}, skipping sync`);
    result.skipped.push(rootFile.path);
    return result;
  }

  const sourcePlatform = getPlatformForRootFile(sourceFileName);
  const targetPlatforms =
    sourcePlatform === 'universal'
      ? detectedPlatforms
      : detectedPlatforms.filter(platform => platform === sourcePlatform);

  // Sync to each relevant platform
  for (const platform of targetPlatforms) {
    const platformDef = getPlatformDefinition(platform);
    if (!platformDef.rootFile) {
      continue; // Platform doesn't use root files
    }

    try {
      const targetRootFile = platformDef.rootFile;
      const targetPath = `${cwd}/${targetRootFile}`;

      // Check if target file already exists
      const fileExists = await exists(targetPath);
      let existingContent = '';
      if (fileExists) {
        try {
          existingContent = await readTextFile(targetPath, 'utf8');
        } catch (error) {
          logger.warn(`Failed to read existing file ${targetPath}: ${error}`);
          result.skipped.push(`${platform}:${targetRootFile}`);
          continue;
        }
      }

      // Extract existing section content to compare (only the package section, not entire file)
      const existingSectionContent = fileExists
        ? extractPackageContentFromRootFile(existingContent, packageName)?.trim() ?? null
        : null;

      // Compare section content - only update if it differs
      if (existingSectionContent !== null && existingSectionContent === sectionBody) {
        logger.debug(`Root file section unchanged: ${targetPath} (pkg: ${packageName})`);
        continue; // Skip writing - section content is identical
      }

      // Merge the package content into the target file
      const mergedContent = mergePackageContentIntoRootFile(
        existingContent,
        packageName,
        sectionBody
      );

      // Ensure target directory exists (though root files are at project root)
      await ensureDir(cwd);

      // Write the merged content
      await writeTextFile(targetPath, mergedContent, 'utf8');

      // Record result
      const relativePath = relative(cwd, targetPath);
      if (fileExists) {
        result.updated.push(relativePath);
        logger.debug(`Updated synced root file: ${targetPath}`);
      } else {
        result.created.push(relativePath);
        logger.debug(`Created synced root file: ${targetPath}`);
      }

    } catch (error) {
      logger.warn(`Failed to sync root file ${platformDef.rootFile}: ${error}`);
      result.skipped.push(`${platformDef.rootFile}`);
    }
  }

  return result;
}

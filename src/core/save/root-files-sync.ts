/**
 * Root File Sync Module
 * Utility functions for syncing saved root formula files across detected platforms
 */

import { relative } from 'path';
import { ensureDir, writeTextFile, exists, readTextFile } from '../../utils/fs.js';
import { getDetectedPlatforms, getPlatformDefinition, getAllPlatforms } from '../platforms.js';
import { type Platform } from '../../constants/index.js';
import { logger } from '../../utils/logger.js';
import type { FormulaFile } from '../../types/index.js';
import { getPlatformForRootFile } from '../../utils/root-file-registry.js';
import { mergeFormulaContentIntoRootFile } from '../../utils/root-file-merger.js';
import { ensureRootMarkerIdAndExtract, buildOpenMarker, CLOSE_MARKER } from '../../utils/root-file-extractor.js';
import { getPathLeaf } from '../../utils/path-normalization.js';

/**
 * Result of root file sync operation
 */
export interface RootFileSyncResult {
  created: string[];
  updated: string[];
  skipped: string[];
}

/**
 * Sync saved root formula files across all detected platforms
 * Converts between platform-specific root files (e.g., CLAUDE.md ↔ AGENTS.md)
 * @param cwd - Current working directory
 * @param formulaFiles - Array of formula files that were saved to registry
 * @param formulaName - Name of the formula being synced
 * @returns Promise resolving to sync result with created, updated, and skipped files
 */
export async function syncRootFiles(
  cwd: string,
  formulaFiles: FormulaFile[],
  formulaName: string
): Promise<RootFileSyncResult> {
  const result: RootFileSyncResult = {
    created: [],
    updated: [],
    skipped: []
  };

  // Get detected platforms
  const detectedPlatforms = await getDetectedPlatforms(cwd);

  if (detectedPlatforms.length === 0) {
    logger.debug('No platforms detected, skipping root file sync');
    return result;
  }

  // Filter formula files to only root files
  const rootFiles = formulaFiles.filter(file => isRootFile(file.path));

  if (rootFiles.length === 0) {
    logger.debug('No root files found in formula, skipping root file sync');
    return result;
  }

  logger.debug(`Starting root file sync for ${rootFiles.length} files across ${detectedPlatforms.length} platforms`);

  // Process each root file
  for (const rootFile of rootFiles) {
    try {
      const syncResults = await syncSingleRootFile(cwd, rootFile, formulaName, detectedPlatforms);
      result.created.push(...syncResults.created);
      result.updated.push(...syncResults.updated);
      result.skipped.push(...syncResults.skipped);
    } catch (error) {
      logger.warn(`Failed to sync root file ${rootFile.path}: ${error}`);
      result.skipped.push(rootFile.path);
    }
  }

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

  const fileName = getPathLeaf(filePath);
  return fileName ? rootFileNames.has(fileName) : false;
}

/**
 * Sync a single root file across detected platforms
 */
async function syncSingleRootFile(
  cwd: string,
  rootFile: FormulaFile,
  formulaName: string,
  detectedPlatforms: Platform[]
): Promise<RootFileSyncResult> {
  const result: RootFileSyncResult = {
    created: [],
    updated: [],
    skipped: []
  };

  const sourceFileName = getPathLeaf(rootFile.path);
  const sourcePlatform = getPlatformForRootFile(sourceFileName);

  // Extract the formula content from the source root file
  const ensured = ensureRootMarkerIdAndExtract(rootFile.content, formulaName);
  if (!ensured) {
    logger.warn(`Invalid marker-wrapped content in ${sourceFileName}, skipping sync`);
    result.skipped.push(rootFile.path);
    return result;
  }

  const formulaContent = buildOpenMarker(formulaName, ensured.id) + '\n' + ensured.sectionBody + '\n' + CLOSE_MARKER;

  // Sync to each detected platform
  for (const platform of detectedPlatforms) {
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

      // Merge the formula content into the target file
      const mergedContent = mergeFormulaContentIntoRootFile(
        existingContent,
        formulaName,
        formulaContent
      );

      // Ensure target directory exists (though root files are at project root)
      await ensureDir(cwd);

      // Write the merged content
      await writeTextFile(targetPath, mergedContent, 'utf8');

      // Record result
      const relativePath = relative(cwd, targetPath);
      if (fileExists) {
        if (existingContent !== mergedContent) {
          result.updated.push(`${relativePath}`);
          logger.debug(`Updated synced root file: ${targetPath}`);
        } else {
          logger.debug(`Root file unchanged: ${targetPath}`);
        }
      } else {
        result.created.push(`${relativePath}`);
        logger.debug(`Created synced root file: ${targetPath}`);
      }

    } catch (error) {
      logger.warn(`Failed to sync root file ${platformDef.rootFile}: ${error}`);
      result.skipped.push(`${platformDef.rootFile}`);
    }
  }

  return result;
}

/**
 * Platform Sync Module
 * Utility functions for syncing saved formula files across detected platforms
 */

import { relative } from 'path';
import { ensureDir, writeTextFile, exists, readTextFile } from './fs.js';
import { getDetectedPlatforms } from '../core/platforms.js';
import { resolveInstallTargets } from './platform-mapper.js';
import { FILE_PATTERNS, UNIVERSAL_SUBDIRS, PLATFORMS, PLATFORM_DIRS, type UniversalSubdir } from '../constants/index.js';
import { logger } from './logger.js';
import type { FormulaFile } from '../types/index.js';
import { parseUniversalPath } from './platform-file.js';

/**
 * Result of platform sync operation
 */
export interface PlatformSyncResult {
  created: string[];
  updated: string[];
}


/**
 * Sync saved formula files across all detected platforms
 * @param cwd - Current working directory
 * @param formulaFiles - Array of formula files that were saved to registry
 * @returns Promise resolving to sync result with created files
 */
export async function postSavePlatformSync(
  cwd: string,
  formulaFiles: FormulaFile[]
): Promise<PlatformSyncResult> {
  const result: PlatformSyncResult = {
    created: [],
    updated: []
  };

  // Get detected platforms
  const detectedPlatforms = await getDetectedPlatforms(cwd);

  if (detectedPlatforms.length === 0) {
    logger.debug('No platforms detected, skipping platform sync');
    return result;
  }

  // Filter formula files to only those in universal subdirs (rules, commands, agents)
  const syncableFiles = formulaFiles.filter(file => {
    const parsed = parseUniversalPath(file.path);
    return parsed !== null;
  });

  if (syncableFiles.length === 0) {
    logger.debug('No syncable files found (no universal subdir files), skipping platform sync');
    return result;
  }

  logger.debug(`Starting platform sync for ${syncableFiles.length} files across ${detectedPlatforms.length} platforms`);

  // Process each syncable file
  for (const file of syncableFiles) {
    const parsedPath = parseUniversalPath(file.path);
    if (!parsedPath) continue;

    // Skip platform-specific files entirely (those with a platform suffix in filename)
    if (parsedPath.platformSuffix) {
      continue;
    }

    // Sync non platform-specific files across detected platforms
    const { universalSubdir, relPath } = parsedPath;

    try {
      // Get all target platforms for this universal file
      const targets = await resolveInstallTargets(cwd, {
        universalSubdir,
        relPath,
        sourceExt: FILE_PATTERNS.MD_FILES
      });

      // Check each target platform
      for (const target of targets) {
        // Ensure target directory exists
        await ensureDir(target.absDir);

        // Check if file already exists and get current contents
        const fileExists = await exists(target.absFile);
        let existingContent = '';
        if (fileExists) {
          try {
            existingContent = await readTextFile(target.absFile, 'utf8');
          } catch (error) {
            logger.warn(`Failed to read existing file ${target.absFile}: ${error}`);
          }
        }

        // Write the file (overwrite if exists to ensure IDs are propagated)
        await writeTextFile(target.absFile, file.content, 'utf8');

        // Record as created or updated based on whether contents changed
        const relativePath = relative(cwd, target.absFile);
        if (fileExists) {
          // Only mark as updated if contents actually changed
          if (existingContent !== file.content) {
            result.updated.push(relativePath);
            logger.debug(`Updated synced file: ${target.absFile}`);
          } else {
            logger.debug(`Synced file unchanged: ${target.absFile}`);
          }
        } else {
          result.created.push(relativePath);
          logger.debug(`Created synced file: ${target.absFile}`);
        }
      }
    } catch (error) {
      logger.warn(`Failed to sync file ${file.path}: ${error}`);
    }
  }

  return result;
}

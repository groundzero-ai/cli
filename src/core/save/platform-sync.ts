/**
 * Platform Sync Module
 * Utility functions for syncing saved formula files across detected platforms
 */

import { basename } from 'path';
import { getDetectedPlatforms } from '../platforms.js';
import { FILE_PATTERNS, PLATFORMS } from '../../constants/index.js';
import { logger } from '../../utils/logger.js';
import type { FormulaFile } from '../../types/index.js';
import { parseUniversalPath } from '../../utils/platform-file.js';
import { syncRootFiles } from './root-files-sync.js';
import { syncUniversalMarkdown } from './md-files-sync.js';
import { syncGenericFile } from './generic-file-sync.js';

/**
 * Result of platform sync operation
 */
export interface PlatformSyncResult {
  created: string[];
  updated: string[];
}

/**
 * Determine if a formula file is syncable across platforms.
 * - Allows universal subdir .md files
 * - Allows index.yml under universal subdirs
 */
function isYamlOverrideFile(relPath: string): boolean {
  // Matches filename.{platform}.yml using platform list from constants
  const alternation = Object.values(PLATFORMS).join('|');
  const regex = new RegExp(`\\\.(?:${alternation})\\\.yml$`, 'i');
  return regex.test(relPath);
}

function isSyncableUniversalFile(file: FormulaFile): boolean {
  const parsed = parseUniversalPath(file.path);
  if (!parsed) return false;

  // Exclude YAML override files; these are used only to merge frontmatter
  if (isYamlOverrideFile(file.path)) return false;

  return true; // Accept any other file in universal subdirs
}


/**
 * Sync saved formula files across all detected platforms
 * @param cwd - Current working directory
 * @param formulaFiles - Array of formula files that were saved to registry
 * @returns Promise resolving to sync result with created files
 */
export async function syncPlatformFiles(
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
  // Include .md files and index.yml (copied verbatim), but exclude other .yml overrides
  const syncableFiles = formulaFiles.filter(isSyncableUniversalFile);

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
    const lower = relPath.toLowerCase();

    try {
      if (lower.endsWith(FILE_PATTERNS.MD_FILES)) {
        // Markdown files: convert extension + merge YAML overrides
        await syncUniversalMarkdown(
          cwd,
          universalSubdir,
          relPath,
          file.content,
          formulaFiles,
          result
        );
      } else {
        // Other files: copy as-is preserving filename and structure
        await syncGenericFile(
          cwd,
          universalSubdir,
          relPath,
          file.content,
          result
        );
      }
    } catch (error) {
      logger.warn(`Failed to sync file ${file.path}: ${error}`);
    }
  }

  return result;
}

export async function performPlatformSync(
  cwd: string,
  formulaName: string,
  formulaFiles: FormulaFile[]
): Promise<PlatformSyncResult> {
  
  // Sync universal files across detected platforms
  const syncResult = await syncPlatformFiles(cwd, formulaFiles);

  // Sync root files across detected platforms
  const rootSyncResult = await syncRootFiles(cwd, formulaFiles, formulaName);

  return {
    created: [...syncResult.created, ...rootSyncResult.created],
    updated: [...syncResult.updated, ...rootSyncResult.updated]
  };
}
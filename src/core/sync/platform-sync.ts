/**
 * Platform Sync Module
 * Utility functions for syncing saved formula files across detected platforms
 */

import { join } from 'path';
import { getDetectedPlatforms } from '../platforms.js';
import { FILE_PATTERNS, PLATFORMS, type Platform } from '../../constants/index.js';
import { logger } from '../../utils/logger.js';
import type { FormulaFile } from '../../types/index.js';
import { parseUniversalPath } from '../../utils/platform-file.js';
import { syncRootFiles } from './root-files-sync.js';
import { syncUniversalMarkdown } from './md-files-sync.js';
import { syncGenericFile } from './generic-file-sync.js';
import { 
  readFormulaIndex, 
  writeFormulaIndex, 
  getFormulaIndexPath,
  type FormulaIndexRecord 
} from '../../utils/formula-index-yml.js';
import { buildIndexMappingForFormulaFiles, loadOtherFormulaIndexes } from '../../utils/index-based-installer.js';
import { getLocalFormulaDir } from '../../utils/paths.js';
import { parseFormulaYml } from '../../utils/formula-yml.js';
import { exists } from '../../utils/fs.js';

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
 * Update formula.index.yml to track synced platform files
 * Reuses the same logic flow as installFormulaByIndex to ensure consistency
 */
async function updateFormulaIndexAfterSync(
  cwd: string,
  formulaName: string,
  formulaFiles: FormulaFile[],
  platforms: Platform[]
): Promise<void> {
  try {
    // Read existing index
    const previousIndex = await readFormulaIndex(cwd, formulaName);
    
    // Load other formula indexes for conflict detection (same as installFormulaByIndex)
    const otherIndexes = await loadOtherFormulaIndexes(cwd, formulaName);
    
    // Get formula version from formula.yml
    const formulaDir = getLocalFormulaDir(cwd, formulaName);
    const formulaYmlPath = join(formulaDir, 'formula.yml');
    let version = previousIndex?.version || '';
    
    if (!version && await exists(formulaYmlPath)) {
      try {
        const formulaYml = await parseFormulaYml(formulaYmlPath);
        version = formulaYml.version;
      } catch (error) {
        logger.warn(`Failed to read formula.yml for version: ${error}`);
        // If we can't get version, skip index update
        return;
      }
    }
    
    if (!version) {
      logger.debug(`No version found for ${formulaName}, skipping index update`);
      return;
    }
    
    // Build index mapping using the same logic as installFormulaByIndex
    // This will create PlannedFiles, group them, decide on dir/file mappings,
    // and build the final index structure
    const newMapping = await buildIndexMappingForFormulaFiles(
      cwd,
      formulaFiles,
      platforms,
      previousIndex,
      otherIndexes
    );
    
    // Merge with existing index (new mapping takes precedence for updated entries)
    const mergedFiles = {
      ...(previousIndex?.files || {}),
      ...newMapping
    };
    
    // Write updated index
    const indexRecord: FormulaIndexRecord = {
      path: getFormulaIndexPath(cwd, formulaName),
      formulaName,
      version,
      files: mergedFiles
    };
    
    await writeFormulaIndex(indexRecord);
    logger.debug(`Updated formula.index.yml for ${formulaName}@${version}`);
    
  } catch (error) {
    logger.warn(`Failed to update formula.index.yml for ${formulaName}: ${error}`);
    // Don't throw - index update failure shouldn't break sync
  }
}

/**
 * Sync saved formula files across all detected platforms
 * @param cwd - Current working directory
 * @param formulaFiles - Array of formula files that were saved to registry
 * @param platforms - Array of platforms to sync files to
 * @returns Promise resolving to sync result with created files
 */
export async function syncPlatformFiles(
  cwd: string,
  formulaFiles: FormulaFile[],
  platforms: Platform[]
): Promise<PlatformSyncResult> {
  const result: PlatformSyncResult = {
    created: [],
    updated: []
  };

  if (platforms.length === 0) {
    logger.debug('No platforms provided, skipping platform sync');
    return result;
  }

  // Filter formula files to only those in universal subdirs (rules, commands, agents)
  // Include .md files and index.yml (copied verbatim), but exclude other .yml overrides
  const syncableFiles = formulaFiles.filter(isSyncableUniversalFile);

  if (syncableFiles.length === 0) {
    logger.debug('No syncable files found (no universal subdir files), skipping platform sync');
    return result;
  }

  logger.debug(`Starting platform sync for ${syncableFiles.length} files across ${platforms.length} platforms`);

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
  
  // Get detected platforms (needed for sync and index update)
  const detectedPlatforms = await getDetectedPlatforms(cwd);
  
  // Sync universal files across detected platforms
  const syncResult = await syncPlatformFiles(cwd, formulaFiles, detectedPlatforms);

  // Sync root files across detected platforms
  const rootSyncResult = await syncRootFiles(cwd, formulaFiles, formulaName, detectedPlatforms);

  // Update formula.index.yml to track synced files
  // This uses the same logic flow as installFormulaByIndex to ensure consistency
  await updateFormulaIndexAfterSync(
    cwd,
    formulaName,
    formulaFiles,
    detectedPlatforms
  );

  return {
    created: [...syncResult.created, ...rootSyncResult.created],
    updated: [...syncResult.updated, ...rootSyncResult.updated]
  };
}
/**
 * Platform Sync Module
 * Utility functions for syncing saved formula files across detected platforms
 */

import { exists, ensureDir, writeTextFile } from './fs.js';
import { getDetectedPlatforms } from '../core/platforms.js';
import { resolveInstallTargets } from './platform-mapper.js';
import { FILE_PATTERNS, UNIVERSAL_SUBDIRS, PLATFORMS, PLATFORM_DIRS, type UniversalSubdir } from '../constants/index.js';
import { logger } from './logger.js';
import type { FormulaFile } from '../types/index.js';

/**
 * Result of platform sync operation
 */
export interface PlatformSyncResult {
  created: string[];
}

/**
 * Parse registry path to extract universal subdir and relative path
 * @param registryPath - The registry path from formula files
 * @returns Parsed information or null if not a universal subdir path
 */
function parseRegistryPath(registryPath: string): { universalSubdir: UniversalSubdir; relPath: string; platformSuffix?: string } | null {
  // Check if path starts with universal subdirs
  const universalSubdirs = Object.values(UNIVERSAL_SUBDIRS) as UniversalSubdir[];

  for (const subdir of universalSubdirs) {
    if (registryPath.startsWith(`${subdir}/`)) {
      const remainingPath = registryPath.substring(subdir.length + 1); // +1 for the slash

      // Check if there's a platform suffix (e.g., auth.cursor.md)
      const parts = remainingPath.split('.');
      if (parts.length >= 3 && parts[parts.length - 1] === 'md') {
        // Check if the second-to-last part is a known platform
        const possiblePlatformSuffix = parts[parts.length - 2];
        const knownPlatforms = Object.values(PLATFORMS) as string[];

        if (knownPlatforms.includes(possiblePlatformSuffix)) {
          // This is a platform-suffixed file
          const baseName = parts.slice(0, -2).join('.'); // Remove .platform.md
          return {
            universalSubdir: subdir,
            relPath: baseName + FILE_PATTERNS.MD_FILES, // Convert back to .md extension
            platformSuffix: possiblePlatformSuffix
          };
        }
      }

      // Regular universal file
      return {
        universalSubdir: subdir,
        relPath: remainingPath
      };
    }
  }

  // Check if path starts with ai/ followed by universal subdirs (for AI directory files)
  if (registryPath.startsWith(`${PLATFORM_DIRS.AI}/`)) {
    const aiPath = registryPath.substring(PLATFORM_DIRS.AI.length + 1); // +1 for the slash

    for (const subdir of universalSubdirs) {
      if (aiPath.startsWith(`${subdir}/`)) {
        const remainingPath = aiPath.substring(subdir.length + 1); // +1 for the slash

        // Check if there's a platform suffix (e.g., auth.cursor.md)
        const parts = remainingPath.split('.');
        if (parts.length >= 3 && parts[parts.length - 1] === 'md') {
          // Check if the second-to-last part is a known platform
          const possiblePlatformSuffix = parts[parts.length - 2];
          const knownPlatforms = Object.values(PLATFORMS) as string[];

          if (knownPlatforms.includes(possiblePlatformSuffix)) {
            // This is a platform-suffixed file
            const baseName = parts.slice(0, -2).join('.'); // Remove .platform.md
            return {
              universalSubdir: subdir,
              relPath: baseName + FILE_PATTERNS.MD_FILES, // Convert back to .md extension
              platformSuffix: possiblePlatformSuffix
            };
          }
        }

        // Regular universal file from AI directory
        return {
          universalSubdir: subdir,
          relPath: remainingPath
        };
      }
    }
  }

  return null;
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
    created: []
  };

  // Get detected platforms
  const detectedPlatforms = await getDetectedPlatforms(cwd);

  if (detectedPlatforms.length === 0) {
    logger.debug('No platforms detected, skipping platform sync');
    return result;
  }

  // Filter formula files to only those in universal subdirs (rules, commands, agents)
  const syncableFiles = formulaFiles.filter(file => {
    const parsed = parseRegistryPath(file.path);
    return parsed !== null;
  });

  if (syncableFiles.length === 0) {
    logger.debug('No syncable files found (no universal subdir files), skipping platform sync');
    return result;
  }

  logger.debug(`Starting platform sync for ${syncableFiles.length} files across ${detectedPlatforms.length} platforms`);

  // Process each syncable file
  for (const file of syncableFiles) {
    const parsedPath = parseRegistryPath(file.path);
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
        // Skip if file already exists
        if (await exists(target.absFile)) {
          continue;
        }

        // Ensure target directory exists
        await ensureDir(target.absDir);

        // Write the file
        await writeTextFile(target.absFile, file.content, 'utf8');

        // Record as created
        result.created.push(target.absFile);
        logger.debug(`Created synced file: ${target.absFile}`);
      }
    } catch (error) {
      logger.warn(`Failed to sync file ${file.path}: ${error}`);
    }
  }

  return result;
}

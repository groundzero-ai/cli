/**
 * Platform Utilities Module
 * Utility functions for platform management, detection, and file operations
 */

import { join } from 'path';
import {
  exists,
  listFiles,
  readTextFile,
  remove,
  getStats
} from './fs.js';
import { logger } from './logger.js';
import { getPathLeaf } from './path-normalization.js';
import {
  getAllPlatforms,
  PLATFORM_DEFINITIONS,
  type Platform,
  type PlatformName,
  type PlatformDetectionResult,
  detectAllPlatforms,
  getPlatformDirectoryPaths,
  createPlatformDirectories,
  validatePlatformStructure,
  getPlatformRulesDirFilePatterns,
  getPlatformUniversalSubdirs,
  getPlatformDefinition
} from '../core/platforms.js';
import { discoverFiles } from '../core/discovery/file-discovery.js';

/**
 * Enhanced platform detection with detailed information
 */
export async function detectPlatformsWithDetails(cwd: string): Promise<{
  detected: Platform[];
  allResults: PlatformDetectionResult[];
  byCategory: Record<string, Platform[]>;
}> {
  const allResults = await detectAllPlatforms(cwd);
  const detected = allResults.filter(result => result.detected).map(result => result.name);

  // Group by category - simplified since we removed categories
  const byCategory = allResults.reduce((acc, result) => {
    if (result.detected) {
      acc['detected'] = acc['detected'] || [];
      acc['detected'].push(result.name);
    }
    return acc;
  }, {} as Record<string, Platform[]>);

  return { detected, allResults, byCategory };
}

/**
 * Find platform-specific files in a directory
 */
export async function findPlatformFiles(
  cwd: string,
  platform: Platform,
  packageName?: string
): Promise<Array<{ fullPath: string; relativePath: string; mtime: number }>> {
  const paths = getPlatformDirectoryPaths(cwd);
  const platformPaths = paths[platform];

  // Check if platform directory exists
  if (!(await exists(platformPaths.rulesDir))) {
    return [];
  }

  const rulesDirFilePatterns = getPlatformRulesDirFilePatterns(platform);
  const allFiles = await listFiles(platformPaths.rulesDir);
  const files: Array<{ fullPath: string; relativePath: string; mtime: number }> = [];
  
  // Process files in parallel for better performance
  const filePromises = allFiles
    .filter(file => rulesDirFilePatterns.some(pattern => file.endsWith(pattern)))
    .map(async (file) => {
      const fullPath = join(platformPaths.rulesDir, file);
      
      try {
        const stats = await getStats(fullPath);
        const mtime = stats.mtime.getTime();
        
        // Frontmatter support removed - no package name filtering
        
        return { fullPath, relativePath: file, mtime };
      } catch (error) {
        logger.debug(`Failed to get stats for ${fullPath}: ${error}`);
        return null;
      }
    });
  
  const results = await Promise.all(filePromises);
  return results.filter((file): file is NonNullable<typeof file> => file !== null);
}

/**
 * Clean up platform-specific files
 */
export async function cleanupPlatformFiles(
  targetDir: string,
  platform: Platform,
  packageName: string,
  options: { force?: boolean; dryRun?: boolean } = {}
): Promise<{ removedCount: number; files: string[]; errors: string[] }> {
  const paths = getPlatformDirectoryPaths(targetDir);
  const platformPaths = paths[platform];

  // If no rules dir, platform not present
  if (!platformPaths || !(await exists(platformPaths.rulesDir))) {
    return { removedCount: 0, files: [], errors: [] };
  }

  const removedFiles: string[] = [];
  const errors: string[] = [];

  try {
    // Build subdir list using centralized helper
    const subdirs = getPlatformUniversalSubdirs(targetDir, platform);
    const definition = getPlatformDefinition(platform);

    // const filePatterns = getPlatformRulesDirFilePatterns(platform);

    for (const { dir, label } of subdirs) {
      const subdirDef = definition.subdirs[label as keyof typeof definition.subdirs];
      const discovered = await discoverFiles(
        dir,
        packageName,
        {
          platform,
          registryPathPrefix: label,
          sourceDirLabel: platform,
          fileExtensions: subdirDef?.readExts ?? []
        }
      );

      const removalPromises = discovered.map(async (file) => {
        if (!options.dryRun) {
          try {
            await remove(file.fullPath);
            logger.debug(`Removed platform file: ${file.fullPath}`);
          } catch (error) {
            logger.error(`Failed to remove file ${file.fullPath}: ${error}`);
            return { success: false, path: file.fullPath };
          }
        }
        return { success: true, path: file.fullPath };
      });

      const results = await Promise.all(removalPromises);
      for (const r of results) {
        if (r.success) removedFiles.push(r.path); else errors.push(r.path);
      }
    }

    return { removedCount: removedFiles.length, files: removedFiles, errors };
  } catch (error) {
    logger.error(`Failed to cleanup platform files for ${platform}: ${error}`);
    return { removedCount: 0, files: [], errors: [`Failed to cleanup ${platform}: ${error}`] };
  }
}


/**
 * Validate all platform structures
 */
export async function validateAllPlatforms(cwd: string): Promise<{
  valid: PlatformName[];
  invalid: Array<{ platform: PlatformName; issues: string[] }>;
}> {
  // Process all platforms in parallel for better performance
  const validationPromises = getAllPlatforms().map(async (platform) => {
    const validation = await validatePlatformStructure(cwd, platform);
    return { platform, validation };
  });
  
  const results = await Promise.all(validationPromises);
  
  const valid: PlatformName[] = [];
  const invalid: Array<{ platform: PlatformName; issues: string[] }> = [];
  
  for (const { platform, validation } of results) {
    if (validation.valid) {
      valid.push(platform);
    } else {
      invalid.push({ platform, issues: validation.issues });
    }
  }
  
  return { valid, invalid };
}

/**
 * Create platform directories for detected platforms
 */
export async function setupDetectedPlatforms(cwd: string): Promise<{
  created: string[];
  errors: string[];
}> {
  const { detected } = await detectPlatformsWithDetails(cwd);
  
  // Process all platforms in parallel for better performance
  const setupPromises = detected.map(async (platform) => {
    try {
      const platformDirs = await createPlatformDirectories(cwd, [platform]);
      return { success: true, dirs: platformDirs, platform };
    } catch (error) {
      logger.error(`Failed to create directories for ${platform}: ${error}`);
      return { success: false, error: `${platform}: ${error}`, platform };
    }
  });
  
  const results = await Promise.all(setupPromises);
  
  const created: string[] = [];
  const errors: string[] = [];
  
  for (const result of results) {
    if (result.success) {
      created.push(...(result.dirs || []));
    } else {
      errors.push(result.error || 'Unknown error');
    }
  }
  
  return { created, errors };
}

/**
 * Extract platform name from source directory path
 * Uses platform definitions for scalable platform detection
 */
export function getPlatformNameFromSource(sourceDir: string): string {
  // Use platform definitions to find matching platform
  for (const platform of getAllPlatforms()) {
    const definition = PLATFORM_DEFINITIONS[platform];

    // Check if sourceDir includes the platform's root directory
    if (sourceDir.includes(definition.rootDir)) {
      return platform;
    }

    // Also check subdirs if they exist
    for (const [subdirName, subdirDef] of Object.entries(definition.subdirs)) {
      const subdirPath = join(definition.rootDir, subdirDef.path);
      if (sourceDir.includes(subdirPath)) {
        return platform;
      }
    }
  }

  // Fallback: extract from path
  return getPathLeaf(sourceDir) || 'unknown';
}

/**
 * Get all platform directory names
 * Returns an array of all supported platform directory names
 */
export function getAllPlatformDirs(): string[] {
  const dirs = new Set<string>();
  for (const platform of getAllPlatforms({ includeDisabled: true })) {
    dirs.add(PLATFORM_DEFINITIONS[platform].rootDir);
  }
  return Array.from(dirs);
}




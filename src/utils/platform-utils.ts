/**
 * Platform Utilities Module
 * Utility functions for platform management, detection, and file operations
 */

import { join, basename, dirname, relative } from 'path';
import path from 'path';
import { 
  exists, 
  ensureDir, 
  listFiles,
  readTextFile,
  writeTextFile,
  remove,
  getStats
} from './fs.js';
import { logger } from './logger.js';
import { parseMarkdownFrontmatter } from './formula-yml.js';
import {
  getAllPlatforms,
  PLATFORM_DEFINITIONS,
  PLATFORM_CATEGORIES,
  type Platform,
  type PlatformName,
  type PlatformDetectionResult,
  detectAllPlatforms,
  getPlatformDirectoryPaths,
  createPlatformDirectories,
  validatePlatformStructure,
  getPlatformRulesDirFilePatterns,
  getPlatformDescription
} from '../core/platforms.js';
import { PLATFORMS, PLATFORM_DIRS, UNIVERSAL_SUBDIRS, FILE_PATTERNS, GLOBAL_PLATFORM_FILES } from '../constants/index.js';
import { discoverFiles } from './file-discovery.js';

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
  formulaName?: string
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
        
        // Check frontmatter if formula name is specified
        if (formulaName) {
          try {
            const content = await readTextFile(fullPath);
            const frontmatter = parseMarkdownFrontmatter(content);
            
            if (frontmatter?.formula?.name !== formulaName) {
              return null;
            }
          } catch (error) {
            logger.debug(`Failed to parse frontmatter for ${fullPath}: ${error}`);
            return null;
          }
        }
        
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
  formulaName: string,
  options: { force?: boolean; dryRun?: boolean } = {}
): Promise<{ removedCount: number; files: string[]; errors: string[] }> {
  const paths = getPlatformDirectoryPaths(targetDir);
  const platformPaths = paths[platform];

  // If no rules dir, platform not present
  if (!platformPaths || !(await exists(platformPaths.rulesDir))) {
    return { removedCount: 0, files: [], errors: [] };
  }

  const preservedGlobal = new Set<string>(Object.values(GLOBAL_PLATFORM_FILES));
  const removedFiles: string[] = [];
  const errors: string[] = [];

  try {
    // Build subdir list: rules, commands, agents
    const subdirs: Array<{ dir: string; label: string; leaf: string }> = [];
    if (platformPaths.rulesDir) subdirs.push({ dir: platformPaths.rulesDir, label: UNIVERSAL_SUBDIRS.RULES, leaf: platformPaths.rulesDir.split('/').pop() || '' });
    if (platformPaths.commandsDir) subdirs.push({ dir: platformPaths.commandsDir, label: UNIVERSAL_SUBDIRS.COMMANDS, leaf: platformPaths.commandsDir.split('/').pop() || '' });
    if (platformPaths.agentsDir) subdirs.push({ dir: platformPaths.agentsDir, label: UNIVERSAL_SUBDIRS.AGENTS, leaf: platformPaths.agentsDir.split('/').pop() || '' });

    const filePatterns = getPlatformRulesDirFilePatterns(platform);

    for (const { dir, label, leaf } of subdirs) {

      const discovered = await discoverFiles(
        dir,
        formulaName,
        platform,
        label,
        filePatterns,
        'platform'
      );

      const removalPromises = discovered.map(async (file) => {
        const relFromCwd = relative(targetDir, file.fullPath).replace(/\\/g, '/');
        if (preservedGlobal.has(relFromCwd)) {
          return { success: true, path: file.fullPath };
        }
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
 * Get platform status information
 */
export async function getPlatformStatus(cwd: string): Promise<{
  platforms: Array<{
    name: Platform;
    detected: boolean;
    directoryExists: boolean;
    filesPresent: boolean;
    fileCount: number;
    category: string;
    description: string;
  }>;
  summary: {
    total: number;
    detected: number;
    byCategory: Record<string, number>;
  };
}> {
  const results = await detectAllPlatforms(cwd);
  const summary = {
    total: results.length,
    detected: 0,
    byCategory: {} as Record<string, number>
  };
  
  // Process platforms in parallel for better performance
  const platformPromises = results.map(async (result) => {
    let fileCount = 0;
    const definition = PLATFORM_DEFINITIONS[result.name];

    if (result.detected) {
      try {
        const files = await findPlatformFiles(cwd, result.name);
        fileCount = files.length;
      } catch (error) {
        logger.debug(`Failed to count files for ${result.name}: ${error}`);
      }
    }

    return {
      name: result.name,
      detected: result.detected,
      directoryExists: result.detected, // Since we only check rootDir existence now
      filesPresent: fileCount > 0,
      fileCount,
      category: 'platform',
      description: getPlatformDescription(result.name)
    };
  });
  
  const platforms = await Promise.all(platformPromises);
  
  // Calculate summary
  for (const platform of platforms) {
    if (platform.detected) {
      summary.detected++;
      summary.byCategory[platform.category] = (summary.byCategory[platform.category] || 0) + 1;
    }
  }
  
  return { platforms, summary };
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
  // Handle special case for AI directory
  if (sourceDir === PLATFORM_DIRS.AI) {
    return PLATFORM_DIRS.AI;
  }

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
  const parts = sourceDir.split('/');
  return parts[parts.length - 1] || 'unknown';
}


/**
 * Get the appropriate target directory for saving a file based on its registry path
 * Legacy function for backward compatibility - simplified version
 */
export function getTargetDirectory(targetPath: string, registryPath: string): string {
  const { join } = path;

  if (!registryPath.endsWith(FILE_PATTERNS.MD_FILES)) {
    return targetPath;
  }

  // Check if the first part is a known platform directory
  const pathParts = registryPath.split('/');
  const firstPart = pathParts[0];

  const platformDirectories = Object.values(PLATFORM_DIRS) as string[];
  if (platformDirectories.includes(firstPart)) {
    // Special case: AI directory should not be prefixed again since it's already the base
    if (firstPart === PLATFORM_DIRS.AI) {
      return targetPath;
    }
    return join(targetPath, firstPart);
  }

  // For universal subdirs, return target path as-is
  return targetPath;
}

/**
 * Get the appropriate target file path for saving
 * Handles platform-specific file naming conventions using platform definitions
 */
export function getTargetFilePath(targetDir: string, registryPath: string): string {
  const { join, basename } = path;

  if (!registryPath.endsWith(FILE_PATTERNS.MD_FILES)) {
    return join(targetDir, registryPath);
  }

  // Check if the file is in a platform-specific commands directory
  // If so, just use the basename (they already have the correct structure)
  for (const platform of getAllPlatforms()) {
    const definition = PLATFORM_DEFINITIONS[platform];
    const commandsSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.COMMANDS];
    if (commandsSubdir && registryPath.includes(join(definition.rootDir, commandsSubdir.path))) {
      return join(targetDir, basename(registryPath));
    }
  }

  // For all other files, preserve the full relative path structure
  return join(targetDir, registryPath);
}


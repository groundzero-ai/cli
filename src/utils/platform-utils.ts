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
  ALL_PLATFORMS,
  PLATFORM_DEFINITIONS,
  PLATFORM_CATEGORIES,
  type PlatformName,
  type PlatformDetectionResult,
  detectAllPlatforms,
  getPlatformDirectoryPaths,
  createPlatformDirectories,
  validatePlatformStructure,
  getPlatformRulesDirFilePatterns,
  isPlatformCategory,
  getPlatformDescription
} from '../core/platforms.js';
import { PLATFORMS, PLATFORM_DIRS, PLATFORM_SUBDIRS, GROUNDZERO_DIRS, FILE_PATTERNS, GLOBAL_PLATFORM_FILES } from '../constants/index.js';
import { discoverFiles } from './file-discovery.js';

/**
 * Enhanced platform detection with detailed information
 */
export async function detectPlatformsWithDetails(cwd: string): Promise<{
  detected: PlatformName[];
  allResults: PlatformDetectionResult[];
  byCategory: Record<string, PlatformName[]>;
}> {
  const allResults = await detectAllPlatforms(cwd);
  const detected = allResults.filter(result => result.detected).map(result => result.name);
  
  // Group by category - get category from platform definitions
  const byCategory = allResults.reduce((acc, result) => {
    if (result.detected) {
      const definition = PLATFORM_DEFINITIONS[result.name];
      const category = definition.category;
      acc[category] = acc[category] || [];
      acc[category].push(result.name);
    }
    return acc;
  }, {} as Record<string, PlatformName[]>);
  
  return { detected, allResults, byCategory };
}

/**
 * Get platform-specific search directories for save command
 */
export function getPlatformSearchDirectories(): Array<{
  name: string;
  basePath: string;
  registryPath: string;
  category: string;
}> {
  const searchDirs = [
    { name: 'ai', basePath: 'ai', registryPath: 'ai', category: 'ai' }
  ];
  
  // Add all platform directories - optimized with single loop
  for (const platform of ALL_PLATFORMS) {
    const definition = PLATFORM_DEFINITIONS[platform];
    let basePath = '';
    
    if (isPlatformCategory(platform, PLATFORM_CATEGORIES.AGENTS_MEMORIES) || 
        isPlatformCategory(platform, PLATFORM_CATEGORIES.ROOT_MEMORIES)) {
      basePath = 'rootFile' in definition ? definition.rootFile! : '';
    } else if (isPlatformCategory(platform, PLATFORM_CATEGORIES.RULES_DIRECTORY)) {
      basePath = definition.rulesDir;
    }
    
    if (basePath) {
      searchDirs.push({
        name: platform,
        basePath,
        registryPath: platform,
        category: definition.category
      });
    }
  }
  
  return searchDirs;
}

/**
 * Find platform-specific files in a directory
 */
export async function findPlatformFiles(
  cwd: string,
  platform: PlatformName,
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
 * Install platform-specific files
 */
export async function installPlatformFiles(
  sourceFiles: Array<{ path: string; content: string }>,
  targetDir: string,
  platform: PlatformName,
  options: { force?: boolean; dryRun?: boolean } = {}
): Promise<{ installedCount: number; files: string[]; conflicts: string[] }> {
  const paths = getPlatformDirectoryPaths(targetDir);
  const platformPaths = paths[platform];
  const installedFiles: string[] = [];
  const conflicts: string[] = [];
  
  // Ensure target directory exists
  if (!options.dryRun) {
    await ensureDir(platformPaths.rulesDir);
  }
  
  // Process files in parallel for better performance
  const filePromises = sourceFiles.map(async (file) => {
    const targetPath = join(platformPaths.rulesDir, basename(file.path));
    
    // Check for conflicts
    if (await exists(targetPath) && !options.force) {
      conflicts.push(targetPath);
      if (!options.dryRun) {
        logger.debug(`Skipping existing file: ${targetPath}`);
      }
      return null;
    }
    
    if (!options.dryRun) {
      try {
        await writeTextFile(targetPath, file.content);
        logger.debug(`Installed platform file: ${targetPath}`);
      } catch (error) {
        logger.error(`Failed to install file ${targetPath}: ${error}`);
        return null;
      }
    }
    
    return targetPath;
  });
  
  const results = await Promise.all(filePromises);
  const validFiles = results.filter((file): file is string => file !== null);
  
  return { 
    installedCount: validFiles.length, 
    files: validFiles, 
    conflicts 
  };
}

/**
 * Clean up platform-specific files
 */
export async function cleanupPlatformFiles(
  targetDir: string,
  platform: PlatformName,
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
    if (platformPaths.rulesDir) subdirs.push({ dir: platformPaths.rulesDir, label: PLATFORM_SUBDIRS.RULES, leaf: platformPaths.rulesDir.split('/').pop() || '' });
    if (platformPaths.commandsDir) subdirs.push({ dir: platformPaths.commandsDir, label: PLATFORM_SUBDIRS.COMMANDS, leaf: platformPaths.commandsDir.split('/').pop() || '' });
    if (platformPaths.agentsDir) subdirs.push({ dir: platformPaths.agentsDir, label: PLATFORM_SUBDIRS.AGENTS, leaf: platformPaths.agentsDir.split('/').pop() || '' });

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
    name: PlatformName;
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
      category: definition.category,
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
  const validationPromises = ALL_PLATFORMS.map(async (platform) => {
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
  for (const platform of ALL_PLATFORMS) {
    const definition = PLATFORM_DEFINITIONS[platform];

    // Check if sourceDir includes the platform's root directory
    if (sourceDir.includes(definition.rootDir)) {
      return platform;
    }

    // Also check rules, commands, and agents directories if they exist
    if (definition.rulesDir && sourceDir.includes(definition.rulesDir)) {
      return platform;
    }
    if (definition.commandsDir && sourceDir.includes(definition.commandsDir)) {
      return platform;
    }
    if (definition.agentsDir && sourceDir.includes(definition.agentsDir)) {
      return platform;
    }
  }

  // Fallback: extract from path
  const parts = sourceDir.split('/');
  return parts[parts.length - 1] || 'unknown';
}

/**
 * Get the appropriate target directory for saving a file based on its registry path
 * Uses platform definitions for accurate directory mapping
 */
export function getTargetDirectory(targetPath: string, registryPath: string): string {
  const { join } = path;
  const MARKDOWN_EXTENSION = '.md';

  if (!registryPath.endsWith(MARKDOWN_EXTENSION)) {
    return targetPath;
  }

  // Split the registry path to understand the structure
  const pathParts = registryPath.split('/');
  const firstPart = pathParts[0];

  // Check if the first part is a known platform directory
  const platformDirectories = Object.values(PLATFORM_DIRS) as string[];
  if (platformDirectories.includes(firstPart)) {
    // Special case: AI directory should not be prefixed again since it's already the base
    if (firstPart === PLATFORM_DIRS.AI) {
      return targetPath;
    }
    return join(targetPath, firstPart);
  }

  // Check for universal subdirectories (rules, commands, agents, etc.)
  const universalSubdirs = Object.values(PLATFORM_SUBDIRS) as string[];
  if (universalSubdirs.includes(firstPart)) {
    // Universal file with subdirectory structure - save directly
    return targetPath;
  }

  // Check for platform-specific subdirectories (commands, agents, etc.)
  for (const platform of ALL_PLATFORMS) {
    const definition = PLATFORM_DEFINITIONS[platform];

    // Check commands directory
    if (definition.commandsDir && registryPath.includes(definition.commandsDir)) {
      return join(targetPath, definition.rootDir, PLATFORM_SUBDIRS.COMMANDS);
    }

    // Check agents directory
    if (definition.agentsDir && registryPath.includes(definition.agentsDir)) {
      return join(targetPath, definition.rootDir, PLATFORM_SUBDIRS.AGENTS);
    }

    // Check rules directory (main platform directory)
    if (registryPath.includes(definition.rootDir)) {
      return join(targetPath, definition.rootDir);
    }
  }

  // Default to AI directory for markdown files
  return join(targetPath, PLATFORM_DIRS.AI);
}

/**
 * Get the appropriate target file path for saving
 * Handles platform-specific file naming conventions using platform definitions
 */
export function getTargetFilePath(targetDir: string, registryPath: string): string {
  const { join, basename } = path;
  const MARKDOWN_EXTENSION = '.md';

  if (!registryPath.endsWith(MARKDOWN_EXTENSION)) {
    return join(targetDir, registryPath);
  }

  // Check if the file is in a platform-specific commands directory
  // If so, just use the basename (they already have the correct structure)
  for (const platform of ALL_PLATFORMS) {
    const definition = PLATFORM_DEFINITIONS[platform];
    if (definition.commandsDir && registryPath.includes(definition.commandsDir)) {
      return join(targetDir, basename(registryPath));
    }
  }

  // For all other files, preserve the full relative path structure
  return join(targetDir, registryPath);
}

/**
 * Get the appropriate subdirectory name for a platform based on universal subdirectory type
 * Maps GROUNDZERO_DIRS (rules/commands/agents) to platform-specific subdirectory names
 */
export function getPlatformSubdirForType(platform: PlatformName, subdirType: string): string | undefined {
  const definition = PLATFORM_DEFINITIONS[platform];

  if (subdirType === GROUNDZERO_DIRS.RULES) {
    return definition.rulesDir.split('/').pop();
  } else if (subdirType === GROUNDZERO_DIRS.COMMANDS) {
    return definition.commandsDir?.split('/').pop();
  } else if (subdirType === GROUNDZERO_DIRS.AGENTS) {
    return definition.agentsDir?.split('/').pop();
  }

  return undefined;
}

/**
 * Adjust file path for platform-specific requirements, primarily handling extension conversion
 * Converts .md/.mdc extensions based on platform expectations while preserving the rest of the path
 */
export function adjustPathForPlatform(platform: PlatformName, relativePath: string): string {
  const expectedExt = platform === PLATFORMS.CURSOR ? FILE_PATTERNS.MDC_FILES : FILE_PATTERNS.MD_FILES;

  // Convert extension if needed
  if (relativePath.endsWith(FILE_PATTERNS.MD_FILES) && expectedExt === FILE_PATTERNS.MDC_FILES) {
    return relativePath.replace(/\.md$/, FILE_PATTERNS.MDC_FILES);
  } else if (relativePath.endsWith(FILE_PATTERNS.MDC_FILES) && expectedExt === FILE_PATTERNS.MD_FILES) {
    return relativePath.replace(/\.mdc$/, FILE_PATTERNS.MD_FILES);
  }

  // Return unchanged if already correct or not a markdown file
  return relativePath;
}

/**
 * Platform Utilities Module
 * Utility functions for platform management, detection, and file operations
 */

import { join, basename } from 'path';
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
  getPlatformFilePatterns,
  isPlatformCategory,
  getPlatformDescription
} from '../core/platforms.js';

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
  
  // Group by category - more efficient approach
  const byCategory = allResults.reduce((acc, result) => {
    if (result.detected) {
      acc[result.category] = acc[result.category] || [];
      acc[result.category].push(result.name);
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
  
  const filePatterns = getPlatformFilePatterns(platform);
  const allFiles = await listFiles(platformPaths.rulesDir);
  const files: Array<{ fullPath: string; relativePath: string; mtime: number }> = [];
  
  // Process files in parallel for better performance
  const filePromises = allFiles
    .filter(file => filePatterns.some(pattern => file.endsWith(pattern)))
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
  
  // Check if platform directory exists
  if (!(await exists(platformPaths.rulesDir))) {
    return { removedCount: 0, files: [], errors: [] };
  }
  
  try {
    // Find formula-specific files
    const files = await findPlatformFiles(targetDir, platform, formulaName);
    const removedFiles: string[] = [];
    const errors: string[] = [];
    
    // Process file removal in parallel
    const removalPromises = files.map(async (file) => {
      if (!options.dryRun) {
        try {
          await remove(file.fullPath);
          logger.debug(`Removed platform file: ${file.fullPath}`);
          return { success: true, path: file.fullPath };
        } catch (error) {
          logger.error(`Failed to remove file ${file.fullPath}: ${error}`);
          return { success: false, path: file.fullPath, error: error as Error };
        }
      }
      return { success: true, path: file.fullPath };
    });
    
    const results = await Promise.all(removalPromises);
    
    for (const result of results) {
      if (result.success) {
        removedFiles.push(result.path);
      } else {
        errors.push(result.path);
      }
    }
    
    // Check if directory is empty and remove it if so
    if (!options.dryRun && removedFiles.length > 0) {
      try {
        const remainingFiles = await listFiles(platformPaths.rulesDir);
        if (remainingFiles.length === 0) {
          await remove(platformPaths.rulesDir);
          logger.debug(`Removed empty platform directory: ${platformPaths.rulesDir}`);
        }
      } catch (error) {
        logger.debug(`Failed to remove empty directory ${platformPaths.rulesDir}: ${error}`);
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
      directoryExists: result.directoryExists,
      filesPresent: result.filesPresent,
      fileCount,
      category: result.category,
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

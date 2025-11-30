import { join, basename } from 'path';
import { getPlatformDefinition, getDetectedPlatforms, getAllPlatforms, type Platform } from '../core/platforms.js';
import { DIR_PATTERNS, FILE_PATTERNS, UNIVERSAL_SUBDIRS, type UniversalSubdir } from '../constants/index.js';
import { normalizePathForProcessing, getRelativePathParts, findSubpathIndex } from './path-normalization.js';
import { getAllPlatformDirs } from './platform-utils.js';

/**
 * Normalize platform names from command line input
 */
export function normalizePlatforms(platforms?: string[]): string[] | undefined {
  if (!platforms || platforms.length === 0) {
    return undefined;
  }
  
  return platforms.map(p => p.toLowerCase());
}

/**
 * Platform Mapper Module
 * Unified functions for mapping between universal subdirs and platform-specific paths
 */

/**
 * Map a universal file path to platform-specific directory and file paths
 */
export function mapUniversalToPlatform(
  platform: Platform,
  subdir: UniversalSubdir,
  relPath: string
): { absDir: string; absFile: string } {
  const definition = getPlatformDefinition(platform);
  const subdirDef = definition.subdirs[subdir];

  if (!subdirDef) {
    throw new Error(`Platform ${platform} does not support subdir ${subdir}`);
  }

  // Build the absolute directory path
  const absDir = join(definition.rootDir, subdirDef.path);

  // Build the absolute file path with correct extension
  const baseName = relPath.replace(/\.[^.]+$/, ''); // Remove any existing extension from full relPath
  const targetFileName = subdirDef.writeExt === undefined ? relPath : baseName + subdirDef.writeExt;
  const absFile = join(absDir, targetFileName);

  return { absDir, absFile };
}

/**
 * Map a platform-specific file path back to universal subdir and relative path
 */
export function mapPlatformFileToUniversal(
  absPath: string
): { platform: Platform; subdir: UniversalSubdir; relPath: string } | null {
  const normalizedPath = normalizePathForProcessing(absPath);

  // Check each platform
  for (const platform of getAllPlatforms({ includeDisabled: true })) {
    const definition = getPlatformDefinition(platform);

    // Check each subdir in this platform
    for (const [subdirName, subdirDef] of Object.entries(definition.subdirs)) {
      const subdir = subdirName as UniversalSubdir;
      const platformSubdirPath = join(definition.rootDir, subdirDef.path);

      // Check if the path contains this platform subdir
      const subdirIndex = findSubpathIndex(normalizedPath, platformSubdirPath);
      if (subdirIndex !== -1) {
        // Extract the relative path within the subdir
        // Find where the subdir ends (either /subdir/ or subdir/)
        const absPattern = `/${platformSubdirPath}/`;
        const relPattern = `${platformSubdirPath}/`;
        const isAbsPattern = normalizedPath.indexOf(absPattern) !== -1;

        const patternLength = isAbsPattern ? absPattern.length : relPattern.length;
        const relPathStart = subdirIndex + patternLength;

        let relPath = normalizedPath.substring(relPathStart);

        // Normalize extension to canonical form (.md)
        // Only normalize if writeExt is defined
        if (subdirDef.writeExt !== undefined && relPath.endsWith(subdirDef.writeExt)) {
          relPath = relPath.replace(new RegExp(`${subdirDef.writeExt}$`), FILE_PATTERNS.MD_FILES);
        }

        return { platform, subdir, relPath };
      }
    }
  }

  return null;
}

/**
 * Resolve install targets for a universal file across all detected platforms
 */
export async function resolveInstallTargets(
  cwd: string,
  file: { universalSubdir: UniversalSubdir; relPath: string; sourceExt: string }
): Promise<Array<{ platform: Platform; absDir: string; absFile: string }>> {
  const detectedPlatforms = await getDetectedPlatforms(cwd);
  const targets: Array<{ platform: Platform; absDir: string; absFile: string }> = [];

  for (const platform of detectedPlatforms) {
    try {
      const { absDir, absFile } = mapUniversalToPlatform(platform, file.universalSubdir, file.relPath);
      targets.push({
        platform,
        absDir: join(cwd, absDir),
        absFile: join(cwd, absFile)
      });
    } catch (error) {
      // Skip platforms that don't support this subdir
      continue;
    }
  }

  return targets;
}

/**
 * Get all platform subdirectories for a given platform and working directory
 */
export function getAllPlatformSubdirs(
  platform: Platform,
  cwd: string
): { rulesDir: string; commandsDir?: string; agentsDir?: string; rootDir: string } {
  const definition = getPlatformDefinition(platform);
  const rulesSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.RULES];

  const result: any = {
    rootDir: join(cwd, definition.rootDir),
    rulesDir: join(cwd, definition.rootDir, rulesSubdir?.path || '')
  };

  if (definition.rootFile) {
    result.rootFile = join(cwd, definition.rootFile);
  }

  const commandsSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.COMMANDS];
  if (commandsSubdir) {
    result.commandsDir = join(cwd, definition.rootDir, commandsSubdir.path);
  }

  const agentsSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.AGENTS];
  if (agentsSubdir) {
    result.agentsDir = join(cwd, definition.rootDir, agentsSubdir.path);
  }

  return result;
}

/**
 * Get the appropriate target directory for saving a file based on its registry path
 * Uses platform definitions for scalable platform detection
 */
export function resolveTargetDirectory(targetPath: string, registryPath: string): string {
  if (!registryPath.endsWith(FILE_PATTERNS.MD_FILES)) {
    return targetPath;
  }

  // Check if the first part is a known platform directory
  const pathParts = getRelativePathParts(registryPath);
  const firstPart = pathParts[0];

  const platformDirectories = getAllPlatformDirs();
  if (platformDirectories.includes(firstPart)) {
    return join(targetPath, firstPart);
  }

  const universalValues: string[] = Object.values(UNIVERSAL_SUBDIRS as Record<string, string>);
  if (universalValues.includes(firstPart)) {
    return join(targetPath, DIR_PATTERNS.OPENPACKAGE);
  }

  // For all other paths, return target path as-is
  return targetPath;
}

/**
 * Get the appropriate target file path for saving
 * Handles platform-specific file naming conventions using platform definitions
 */
export function resolveTargetFilePath(targetDir: string, registryPath: string): string {
  if (!registryPath.endsWith(FILE_PATTERNS.MD_FILES)) {
    return join(targetDir, registryPath);
  }

  // Check if the file is in a platform-specific commands directory
  // If so, just use the basename (they already have the correct structure)
  for (const platform of getAllPlatforms()) {
    const definition = getPlatformDefinition(platform);
    const commandsSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.COMMANDS];
    if (commandsSubdir && registryPath.includes(join(definition.rootDir, commandsSubdir.path))) {
      return join(targetDir, basename(registryPath));
    }
  }

  // For all other files, preserve the full relative path structure
  return join(targetDir, registryPath);
}

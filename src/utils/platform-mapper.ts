import { join, basename } from 'path';
import { getPlatformDefinition, getDetectedPlatforms, getAllPlatforms, type Platform } from '../core/platforms.js';
import { FILE_PATTERNS, PLATFORMS, UNIVERSAL_SUBDIRS, type UniversalSubdir, PLATFORM_DIRS } from '../constants/index.js';

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
  const fileName = basename(relPath);
  const baseName = fileName.replace(/\.[^.]+$/, ''); // Remove any existing extension
  const targetFileName = baseName + subdirDef.writeExt;
  const absFile = join(absDir, targetFileName);

  return { absDir, absFile };
}

/**
 * Map a platform-specific file path back to universal subdir and relative path
 */
export function mapPlatformFileToUniversal(
  absPath: string
): { platform: Platform; subdir: UniversalSubdir; relPath: string } | null {
  const normalizedPath = absPath.replace(/\\/g, '/');

  // Check each platform
  for (const platform of Object.values(PLATFORMS) as Platform[]) {
    const definition = getPlatformDefinition(platform);

    // Check each subdir in this platform
    for (const [subdirName, subdirDef] of Object.entries(definition.subdirs)) {
      const subdir = subdirName as UniversalSubdir;
      const platformSubdirPath = join(definition.rootDir, subdirDef.path);

      // Check if the path starts with this platform subdir
      if (normalizedPath.includes(`/${platformSubdirPath}/`) || normalizedPath.startsWith(`${platformSubdirPath}/`)) {
        // Extract the relative path within the subdir
        const subdirIndex = normalizedPath.indexOf(`/${platformSubdirPath}/`);
        const relPathStart = subdirIndex !== -1
          ? subdirIndex + platformSubdirPath.length + 2 // +2 for the leading slash
          : normalizedPath.indexOf(`${platformSubdirPath}/`) + platformSubdirPath.length + 1;

        let relPath = normalizedPath.substring(relPathStart);

        // Normalize extension to canonical form (.md)
        if (relPath.endsWith(subdirDef.writeExt)) {
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

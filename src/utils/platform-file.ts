/**
 * Platform File Utilities
 * Shared utilities for handling platform-specific file paths and extensions
 */

import { basename } from 'path';
import { getPlatformDefinition } from '../core/platforms.js';
import { FILE_PATTERNS, UNIVERSAL_SUBDIRS, PLATFORMS, PLATFORM_DIRS, type UniversalSubdir, type Platform } from '../constants/index.js';
import { getFirstPathComponent, parsePathWithPrefix } from './path-normalization.js';

/**
 * Parse a registry or universal path to extract subdir and relative path info
 * @param path - The registry path from formula files or universal path
 * @param options - Parsing options
 * @returns Parsed information or null if not a universal subdir path
 */
export function parseUniversalPath(
  path: string,
  options: { allowPlatformSuffix?: boolean } = {}
): { universalSubdir: UniversalSubdir; relPath: string; platformSuffix?: string } | null {
  // Check if path starts with universal subdirs
  const universalSubdirs = Object.values(UNIVERSAL_SUBDIRS) as UniversalSubdir[];

  for (const subdir of universalSubdirs) {
    const parsed = parsePathWithPrefix(path, subdir);
    if (parsed) {
      const remainingPath = parsed.remaining;

      // Check if there's a platform suffix (e.g., auth.cursor.md)
      if (options.allowPlatformSuffix !== false) {
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
      }

      // Regular universal file
      return {
        universalSubdir: subdir,
        relPath: remainingPath
      };
    }
  }

  // Check if path starts with ai/ followed by universal subdirs (for AI directory files)
  const aiParsed = parsePathWithPrefix(path, PLATFORM_DIRS.AI);
  if (aiParsed) {
    const aiPath = aiParsed.remaining;

    for (const subdir of universalSubdirs) {
      const subdirParsed = parsePathWithPrefix(aiPath, subdir);
      if (subdirParsed) {
        const remainingPath = subdirParsed.remaining;

        // Check if there's a platform suffix (e.g., auth.cursor.md)
        if (options.allowPlatformSuffix !== false) {
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
 * Get platform-specific filename for a universal path
 * Converts universal paths like "rules/auth.md" to platform-specific names like "auth.mdc"
 * @param universalPath - Universal path like "rules/auth.md"
 * @param platform - Target platform
 * @returns Platform-specific filename like "auth.mdc"
 */
export function getPlatformSpecificFilename(universalPath: string, platform: Platform): string {
  const universalSubdir = getFirstPathComponent(universalPath);
  const registryFileName = basename(universalPath);

  const platformDef = getPlatformDefinition(platform);
  const subdirDef = platformDef.subdirs[universalSubdir as keyof typeof platformDef.subdirs];

  if (!subdirDef) {
    // Fallback to original filename if subdir not supported by platform
    return registryFileName;
  }

  // Get the base name without extension
  const baseName = registryFileName.replace(/\.[^.]+$/, '');

  // Apply platform-specific write extension, or preserve original if undefined
  if (subdirDef.writeExt === undefined) {
    return registryFileName; // Preserve original extension
  }
  return baseName + subdirDef.writeExt;
}

/**
 * Get platform-specific file path information (full paths with directories)
 * Wrapper around existing platform-mapper utilities for convenience
 * @param cwd - Current working directory
 * @param universalSubdir - Universal subdirectory
 * @param relPath - Relative path within the subdir
 * @param platform - Target platform
 * @returns Object with absolute directory and file paths
 */
export async function getPlatformSpecificPath(
  cwd: string,
  universalSubdir: UniversalSubdir,
  relPath: string,
  platform: Platform
): Promise<{ absDir: string; absFile: string }> {
  // Import here to avoid circular dependencies
  const { mapUniversalToPlatform } = await import('./platform-mapper.js');

  // Get the mapping
  const { absDir, absFile } = mapUniversalToPlatform(platform, universalSubdir, relPath);

  // Convert relative paths to absolute paths
  const { join } = await import('path');
  return {
    absDir: join(cwd, absDir),
    absFile: join(cwd, absFile)
  };
}

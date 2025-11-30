/**
 * Platform File Utilities
 * Shared utilities for handling platform-specific file paths and extensions
 */

import { basename } from 'path';
import { getPlatformDefinition, getAllPlatforms, isPlatformId, type Platform } from '../core/platforms.js';
import { FILE_PATTERNS, UNIVERSAL_SUBDIRS, type UniversalSubdir } from '../constants/index.js';
import { getFirstPathComponent, parsePathWithPrefix } from './path-normalization.js';

/**
 * Parse a registry or universal path to extract subdir and relative path info
 * Platform suffix detection is always enabled and supports both file-level and directory-level suffixes.
 * @param path - The registry path from package files or universal path
 * @param options - Parsing options (allowPlatformSuffix is always true, kept for backward compatibility)
 * @returns Parsed information or null if not a universal subdir path
 */
export function parseUniversalPath(
  path: string,
  options: { allowPlatformSuffix?: boolean } = {}
): { universalSubdir: UniversalSubdir; relPath: string; platformSuffix?: string } | null {
  // Check if path starts with universal subdirs
  const universalSubdirs = Object.values(UNIVERSAL_SUBDIRS) as UniversalSubdir[];
  const knownPlatforms = getAllPlatforms({ includeDisabled: true }) as readonly Platform[];

  for (const subdir of universalSubdirs) {
    const parsed = parsePathWithPrefix(path, subdir);
    if (parsed) {
      const remainingPath = parsed.remaining;
      let platformSuffix: string | undefined;
      let normalizedRelPath = remainingPath;

      // Platform suffix detection is always enabled (options.allowPlatformSuffix defaults to true)
      if (options.allowPlatformSuffix !== false) {
        // Check for directory-level platform suffix (e.g., commands/foo.cursor/bar.md)
        const segments = remainingPath.split('/');
        for (let i = 0; i < segments.length - 1; i++) {
          const segment = segments[i];
          for (const platform of knownPlatforms) {
            if (segment.endsWith(`.${platform}`) && isPlatformId(platform)) {
              platformSuffix = platform;
              // Remove platform suffix from directory name for normalized path
              segments[i] = segment.slice(0, -platform.length - 1);
              normalizedRelPath = segments.join('/');
              break;
            }
          }
          if (platformSuffix) break;
        }

        // Check for file-level platform suffix (e.g., auth.cursor.md) if not already found
        if (!platformSuffix) {
          const parts = remainingPath.split('.');
          if (parts.length >= 3 && parts[parts.length - 1] === 'md') {
            // Check if the second-to-last part is a known platform
            const possiblePlatformSuffix = parts[parts.length - 2];
            if (isPlatformId(possiblePlatformSuffix)) {
              platformSuffix = possiblePlatformSuffix;
              // Remove platform suffix from filename
              const baseName = parts.slice(0, -2).join('.');
              normalizedRelPath = baseName + FILE_PATTERNS.MD_FILES;
            }
          }
        }
      }

      return {
        universalSubdir: subdir,
        relPath: normalizedRelPath,
        platformSuffix
      };
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

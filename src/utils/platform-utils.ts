/**
 * Platform Utilities Module
 * Utility functions for platform management, detection, and file operations
 */

import { join } from 'path';
import { getPathLeaf } from './path-normalization.js';
import { FILE_PATTERNS } from '../constants/index.js';
import {
  getAllPlatforms,
  PLATFORM_DEFINITIONS,
  type Platform,
  type PlatformDetectionResult,
  detectAllPlatforms,
  getPlatformDefinition
} from '../core/platforms.js';

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

let platformRootFilesCache: Set<string> | null = null;

function buildPlatformRootFiles(): Set<string> {
  const rootFiles = new Set<string>();
  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) {
      rootFiles.add(def.rootFile);
    }
  }
  rootFiles.add(FILE_PATTERNS.AGENTS_MD);
  return rootFiles;
}

export function getPlatformRootFiles(): Set<string> {
  if (!platformRootFilesCache) {
    platformRootFilesCache = buildPlatformRootFiles();
  }
  return platformRootFilesCache;
}

export function isPlatformRootFile(fileName: string): boolean {
  return getPlatformRootFiles().has(fileName);
}




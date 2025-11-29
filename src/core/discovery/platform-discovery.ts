import { join,  normalize } from 'path';
import { DIR_PATTERNS, FILE_PATTERNS, UNIVERSAL_SUBDIRS } from '../../constants/index.js';
import {
  getDetectedPlatforms,
  getPlatformDefinition,
  getAllPlatforms,
  type PlatformName
} from '../../core/platforms.js';
import { matchPlatformPattern, isExactPlatformMatch } from '../../utils/path-matching.js';

// Import the shared type
import type { Platformish } from '../../utils/file-processing.js';

// Platform search configuration interface
export interface PlatformSearchConfig {
  name: string;
  platform: Platformish;
  rootDir: string;
  rulesDir: string;
  commandsDir?: string;
  agentsDir?: string;
  filePatterns: string[];
  registryPath: string;
}

/**
 * Check if a path matches a platform pattern and extract platform info
 * This function works across different filesystem types (Windows, macOS, Linux, etc.)
 */
function checkPlatformMatch(normalizedPath: string, platform: Platformish, platformDir: string): { platform: string; relativePath: string; platformName: Platformish } | null {
  // Use the cross-platform path matching utility
  const match = matchPlatformPattern(normalizedPath, platformDir);

  if (match) {
    return {
      platform,
      relativePath: match.relativePath,
      platformName: platform
    };
  }

  // Check for exact platform directory matches using the utility
  if (isExactPlatformMatch(normalizedPath, platformDir)) {
    return {
      platform,
      relativePath: '',
      platformName: platform
    };
  }

  return null;
}


/**
 * Parse a directory path to determine if it's a platform-specific directory
 */
export function parsePlatformDirectory(directoryPath: string): { platform: string; relativePath: string; platformName: Platformish } | null {
  // Use proper path normalization for cross-platform compatibility
  const normalizedPath = normalize(directoryPath);

  // Check for AI directory first (special case)
  const aiMatch = checkPlatformMatch(normalizedPath, DIR_PATTERNS.AI, DIR_PATTERNS.AI);
  if (aiMatch) {
    return aiMatch;
  }

  // Check for other platforms
  const platforms = getAllPlatforms({ includeDisabled: true }) as PlatformName[];
  for (const platform of platforms) {
    const platformDir = getPlatformDefinition(platform).rootDir;
    const match = checkPlatformMatch(normalizedPath, platform, platformDir);
    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Build platform-based search configuration for file discovery
 */
export async function buildPlatformSearchConfig(cwd: string): Promise<PlatformSearchConfig[]> {
  const detectedPlatforms = await getDetectedPlatforms(cwd);
  const config: PlatformSearchConfig[] = [];

  // Add AI directory as required feature
  config.push({
    name: DIR_PATTERNS.AI,
    platform: DIR_PATTERNS.AI as Platformish,
    rootDir: DIR_PATTERNS.AI,
    rulesDir: join(cwd, DIR_PATTERNS.AI),
    filePatterns: [FILE_PATTERNS.MD_FILES],
    registryPath: ''
  });

  // Add detected platform configurations
  for (const platform of detectedPlatforms) {
    const definition = getPlatformDefinition(platform);

    config.push({
      name: platform,
      platform,
      rootDir: definition.rootDir,
      rulesDir: join(cwd, definition.rootDir, definition.subdirs[UNIVERSAL_SUBDIRS.RULES]?.path || ''),
      commandsDir: definition.subdirs[UNIVERSAL_SUBDIRS.COMMANDS] ? join(cwd, definition.rootDir, definition.subdirs[UNIVERSAL_SUBDIRS.COMMANDS]!.path) : undefined,
      agentsDir: definition.subdirs[UNIVERSAL_SUBDIRS.AGENTS] ? join(cwd, definition.rootDir, definition.subdirs[UNIVERSAL_SUBDIRS.AGENTS]!.path) : undefined,
      filePatterns: definition.subdirs[UNIVERSAL_SUBDIRS.RULES]?.readExts || [],
      registryPath: ''
    });
  }

  return config;
}

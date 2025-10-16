import { join, dirname, normalize } from 'path';
import { FILE_PATTERNS, PLATFORMS, PLATFORM_DIRS, UNIVERSAL_SUBDIRS, type UniversalSubdir } from '../../constants/index.js';
import { logger } from '../logger.js';
import { exists, isDirectory } from '../fs.js';
import {
  getDetectedPlatforms,
  getPlatformDefinition,
  type Platform,
  type PlatformName
} from '../../core/platforms.js';
import { discoverFiles } from './file-processing.js';
import type { DiscoveredFile } from '../../types/index.js';
import { matchPlatformPattern, isExactPlatformMatch } from '../path-matching.js';

// Import the shared type
import type { Platformish } from './file-processing.js';

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
  const aiMatch = checkPlatformMatch(normalizedPath, PLATFORM_DIRS.AI, PLATFORM_DIRS.AI);
  if (aiMatch) {
    return aiMatch;
  }

  // Check for other platforms
  const platforms = Object.values(PLATFORMS) as PlatformName[];
  for (const platform of platforms) {
    // Map platform name to platform directory using the correct key format
    const platformKey = platform.toUpperCase() as keyof typeof PLATFORM_DIRS;
    const platformDir = PLATFORM_DIRS[platformKey];
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
    name: PLATFORM_DIRS.AI,
    platform: PLATFORM_DIRS.AI as Platformish,
    rootDir: PLATFORM_DIRS.AI,
    rulesDir: join(cwd, PLATFORM_DIRS.AI),
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
      filePatterns: definition.subdirs[UNIVERSAL_SUBDIRS.RULES]?.readExts || [FILE_PATTERNS.MD_FILES],
      registryPath: ''
    });
  }

  return config;
}

/**
 * Process platform subdirectories (rules/commands/agents) within a base directory
 * Common logic shared between different discovery methods
 */
export async function processPlatformSubdirectories(
  baseDir: string,
  formulaName: string,
  platformName: Platformish,
  formulaDir?: string,
  isDirectoryMode?: boolean
): Promise<DiscoveredFile[]> {
  const definition = getPlatformDefinition(platformName as Platform);
  const allFiles: DiscoveredFile[] = [];

  // Process each universal subdir that this platform supports
  for (const [subdirName, subdirDef] of Object.entries(definition.subdirs)) {
    const subdir = subdirName as UniversalSubdir;
    const subdirPath = join(baseDir, subdirDef.path);

    if (await exists(subdirPath) && await isDirectory(subdirPath)) {
      const files = await discoverFiles(
        subdirPath,
        formulaName,
        platformName,
        subdir, // Universal registry path
        subdirDef.readExts,
        'platform',
        formulaDir,
        true,
        isDirectoryMode
      );
      allFiles.push(...files);
    }
  }

  return allFiles;
}


/**
 * Process files for a specific platform configuration
 */
export async function processPlatformFiles(
  config: PlatformSearchConfig,
  formulaDir: string,
  formulaName: string,
  isDirectoryMode?: boolean
): Promise<DiscoveredFile[]> {
  // Handle AI directory separately - it's not a platform subdirectory structure
  if (config.name === PLATFORM_DIRS.AI) {
    return discoverFiles(
      config.rulesDir,
      formulaName,
      config.platform,
      PLATFORM_DIRS.AI, // AI directory uses 'ai' prefix
      config.filePatterns,
      'platform',
      formulaDir,
      true,
      isDirectoryMode
    );
  }

  // Process platform subdirectories with universal registry paths
  return processPlatformSubdirectories(config.rootDir, formulaName, config.platform, formulaDir, isDirectoryMode);
}

/**
 * Determine if a markdown file should be included based on frontmatter rules
 */
export function shouldIncludeMarkdownFile(
  mdFile: { relativePath: string },
  frontmatter: any,
  sourceDir: Platformish,
  formulaName: string,
  isDirectoryMode?: boolean
): boolean {
  // For directory mode in platform directories, include files without conflicting frontmatter
  if (isDirectoryMode) {
    if (!frontmatter || !frontmatter.formula || frontmatter.formula.name === formulaName) {
      logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (directory mode, no conflicting frontmatter)`);
      return true;
    }
    logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDir} (directory mode, conflicting frontmatter)`);
    return false;
  }

  // Otherwise, include files with matching frontmatter
  if (frontmatter?.formula?.name === formulaName) {
    logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (matches formula name in frontmatter)`);
    return true;
  }

  logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDir} (no matching frontmatter)`);
  return false;
}

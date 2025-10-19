import { join } from 'path';
import { FILE_PATTERNS, UNIVERSAL_SUBDIRS, PLATFORM_DIRS } from '../../constants/index.js';
import { discoverFiles } from './file-processing.js';
import {
  buildPlatformSearchConfig,
  processPlatformFiles,
  parsePlatformDirectory,
  processPlatformSubdirectories
} from './platform-discovery.js';
import type { Platformish } from './file-processing.js';
import { mapPlatformFileToUniversal } from '../platform-mapper.js';
import { getPlatformDefinition, type Platform } from '../../core/platforms.js';
import type { DiscoveredFile } from '../../types/index.js';
import { normalizePathForProcessing } from '../path-normalization.js';
import { discoverFromIndexYmlRecursive } from './index-yml-discovery.js';

/**
 * Get file patterns for a given platform info
 */
function getFilePatternsForPlatform(platformInfo: { platformName: Platformish }): string[] {
  if (platformInfo.platformName === PLATFORM_DIRS.AI) {
    return [FILE_PATTERNS.MD_FILES];
  }

  const definition = getPlatformDefinition(platformInfo.platformName as any);
  return definition.subdirs[UNIVERSAL_SUBDIRS.RULES]?.readExts || [FILE_PATTERNS.MD_FILES];
}

/**
 * Calculate registry path prefix for platform-specific directories
 */
function calculateRegistryPathPrefix(directoryPath: string, platformInfo: { platform: string; relativePath: string; platformName: Platformish }): string {
  const dummyPath = join(directoryPath, 'dummy.md');
  const mapping = mapPlatformFileToUniversal(dummyPath);
  if (mapping) {
    return join(mapping.subdir, platformInfo.relativePath || '');
  } else {
    return platformInfo.relativePath ? join(platformInfo.platform, platformInfo.relativePath) : platformInfo.platform;
  }
}

/**
 * Unified file discovery function that searches platform-specific directories
 */
export async function discoverMdFilesUnified(formulaDir: string, formulaName: string, baseDir?: string, isDirectoryMode?: boolean): Promise<DiscoveredFile[]> {
  const cwd = baseDir || process.cwd();
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  const allDiscoveredFiles: DiscoveredFile[] = [];

  // Process all platform configurations in parallel
  const processPromises = platformConfigs.map(async (config) => {
    return processPlatformFiles(config, formulaDir, formulaName, isDirectoryMode);
  });

  const results = await Promise.all(processPromises);
  allDiscoveredFiles.push(...results.flat());

  return allDiscoveredFiles;
}

/**
 * Unified function for discovering md files with configurable options
 */
async function discoverDirectMdFilesWithOptions(
  directoryPath: string,
  formulaName: string,
  platformInfo: { platform: string; relativePath: string; platformName: Platformish } | null,
  recursive: boolean = false
): Promise<DiscoveredFile[]> {
  if (!platformInfo) {
    // Non-platform directory - search for .md files directly
    return discoverFiles(directoryPath, formulaName, PLATFORM_DIRS.AI, '', [FILE_PATTERNS.MD_FILES], 'directory', undefined, recursive);
  } else {
    // Platform-specific directory - search for .md files and map to universal subdirs
    const filePatterns = getFilePatternsForPlatform(platformInfo);
    const registryPathPrefix = calculateRegistryPathPrefix(directoryPath, platformInfo);

    return discoverFiles(directoryPath, formulaName, platformInfo.platformName, registryPathPrefix, filePatterns, 'directory', undefined, recursive);
  }
}

/**
 * Discover files based on the input pattern (directory path or formula name)
 * @param formulaDir - Path to the formula directory
 * @param formulaName - Name of the formula
 * @param directoryPath - Optional directory path if provided
 * @returns Promise resolving to array of discovered files
 */
export async function discoverFilesForPattern(
  formulaDir: string,
  formulaName: string
): Promise<DiscoveredFile[]> {
  const unified = await discoverMdFilesUnified(formulaDir, formulaName);
  // Also attempt index.yml discovery at project root and platform roots
  const cwd = process.cwd();
  const indexAtRoot = await discoverFromIndexYmlRecursive(cwd, formulaName);
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  const indexAtPlatformsResults = await Promise.all(platformConfigs.map(async (cfg) => {
    // cfg.rootDir is relative (e.g., 'cursor'), make absolute
    const absRoot = join(cwd, cfg.rootDir);
    return discoverFromIndexYmlRecursive(absRoot, formulaName);
  }));
  const indexAtPlatforms = indexAtPlatformsResults.flat();
  return dedupeDiscoveredFilesPreferUniversal([...unified, ...indexAtRoot, ...indexAtPlatforms]);
}

/**
 * Dedupe discovered files by source fullPath, preferring universal subdirs over ai
 */
export function dedupeDiscoveredFilesPreferUniversal(files: DiscoveredFile[]): DiscoveredFile[] {
  const preference = (file: DiscoveredFile): number => {
    if (file.discoveredViaIndexYml) return 100; // Highest priority
    // Normalize registry path to use forward slashes for consistent comparison
    const normalizedPath = normalizePathForProcessing(file.registryPath);

    if (normalizedPath.startsWith(`${UNIVERSAL_SUBDIRS.RULES}/`) || normalizedPath === UNIVERSAL_SUBDIRS.RULES) return 3;
    if (normalizedPath.startsWith(`${UNIVERSAL_SUBDIRS.COMMANDS}/`) || normalizedPath === UNIVERSAL_SUBDIRS.COMMANDS) return 3;
    if (normalizedPath.startsWith(`${UNIVERSAL_SUBDIRS.AGENTS}/`) || normalizedPath === UNIVERSAL_SUBDIRS.AGENTS) return 3;
    if (normalizedPath.startsWith(`${PLATFORM_DIRS.AI}/`) || normalizedPath === PLATFORM_DIRS.AI) return 2;
    return 1;
  };

  const map = new Map<string, DiscoveredFile>();
  for (const file of files) {
    const existing = map.get(file.fullPath);
    if (!existing) {
      map.set(file.fullPath, file);
      continue;
    }
    if (preference(file) > preference(existing)) {
      map.set(file.fullPath, file);
    }
  }
  return Array.from(map.values());
}

import { join } from 'path';
import { FILE_PATTERNS, UNIVERSAL_SUBDIRS, PLATFORM_DIRS } from '../../constants/index.js';
import { logger } from '../logger.js';
import { discoverFiles } from './file-processing.js';
import { 
  buildPlatformSearchConfig, 
  processPlatformFiles, 
  parsePlatformDirectory
} from './platform-discovery.js';
import type { Platformish } from './file-processing.js';
import { mapPlatformFileToUniversal } from '../platform-mapper.js';
import { getPlatformDefinition } from '../../core/platforms.js';
import type { DiscoveredFile } from '../../types/index.js';

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
 * Discover md files directly in a directory (shallow search - only immediate directory, not subdirectories)
 */
export async function discoverFilesShallow(
  directoryPath: string,
  formulaName: string,
  platformName: Platformish,
  registryPathPrefix: string = '',
  filePatterns: string[] = [FILE_PATTERNS.MD_FILES],
  inclusionMode: 'directory' | 'platform' = 'directory'
): Promise<DiscoveredFile[]> {
  return discoverFiles(directoryPath, formulaName, platformName, registryPathPrefix, filePatterns, inclusionMode, undefined, false);
}

/**
 * Discover md files directly in a specified directory (not in platform subdirectories)
 */
export async function discoverDirectMdFiles(
  directoryPath: string,
  formulaName: string,
  platformInfo?: { platform: string; relativePath: string; platformName: Platformish } | null
): Promise<DiscoveredFile[]> {
  if (!platformInfo) {
    // Non-platform directory - search for .md files directly
    return discoverFiles(directoryPath, formulaName, PLATFORM_DIRS.AI, '', [FILE_PATTERNS.MD_FILES], 'directory');
  } else {
    // Platform-specific directory - search for .md files directly (shallow) and map to universal subdirs
    const filePatterns = platformInfo.platformName === PLATFORM_DIRS.AI
      ? [FILE_PATTERNS.MD_FILES]
      : (() => {
          const definition = getPlatformDefinition(platformInfo.platformName as any);
          return definition.subdirs[UNIVERSAL_SUBDIRS.RULES]?.readExts || [FILE_PATTERNS.MD_FILES];
        })();

    // Use the mapper to determine the universal path
    const mapping = mapPlatformFileToUniversal(directoryPath + '/dummy.md'); // Use dummy file to get path mapping
    let registryPathPrefix: string;
    if (mapping) {
      registryPathPrefix = join(mapping.subdir, platformInfo.relativePath || '');
    } else {
      // Fallback: keep platform path structure
      registryPathPrefix = platformInfo.relativePath ? join(platformInfo.platform, platformInfo.relativePath) : platformInfo.platform;
    }

    return discoverFilesShallow(directoryPath, formulaName, platformInfo.platformName, registryPathPrefix, filePatterns, 'directory');
  }
}

/**
 * Discover files based on the input pattern (explicit directory, directory mode, or formula name)
 * @param formulaDir - Path to the formula directory
 * @param formulaName - Name of the formula
 * @param isExplicitPair - Whether this is an explicit name + directory pair
 * @param isDirectory - Whether input was a directory path
 * @param directoryPath - The directory path if provided
 * @param sourceDir - The resolved source directory to search in
 * @returns Promise resolving to array of discovered files
 */
export async function discoverFilesForPattern(
  formulaDir: string,
  formulaName: string,
  isExplicitPair: boolean,
  isDirectory: boolean,
  directoryPath: string | undefined,
  sourceDir: string
): Promise<DiscoveredFile[]> {
  if ((isExplicitPair || isDirectory) && directoryPath) {
    // Patterns 1 & 2: Directory-based input
    const results: DiscoveredFile[] = [];
    const platformInfo = parsePlatformDirectory(directoryPath);

    if (platformInfo) {
      // Directory is platform-specific - search for direct md files in the specified directory only
      // Don't search for platform subdirectories within the source directory since we already have the explicit path
      const directFiles = await discoverDirectMdFiles(sourceDir, formulaName, platformInfo);
      results.push(...directFiles);

      // Explicitly exclude any accidental ai/ mappings when using a platform-specific directory
      const filteredResults = results.filter((f) => !(f.registryPath === PLATFORM_DIRS.AI || f.registryPath.startsWith(`${PLATFORM_DIRS.AI}/`)));

      // When both formula-name and directory are specified (isExplicitPair), also search globally for frontmatter matches
      if (isExplicitPair) {
        const globalFiles = await discoverMdFilesUnified(formulaDir, formulaName);
        filteredResults.push(...globalFiles);
        return dedupeDiscoveredFilesPreferUniversal(filteredResults);
      }

      return filteredResults;
    } else {
      // Directory is not platform-specific - search for platform subdirectories from cwd + direct files
      const platformSubdirFiles = await discoverMdFilesUnified(formulaDir, formulaName, undefined, true);
      results.push(...platformSubdirFiles);

      // Also search for direct files in the specified directory
      const directFiles = await discoverDirectMdFiles(sourceDir, formulaName, null);
      results.push(...directFiles);

      // When both formula-name and directory are specified (isExplicitPair), also search globally for additional frontmatter matches
      if (isExplicitPair) {
        const globalFiles = await discoverMdFilesUnified(formulaDir, formulaName);
        results.push(...globalFiles);
        return dedupeDiscoveredFilesPreferUniversal(results);
      }
    }

    return results;
  } else {
    // Pattern 3: Legacy formula name input - use unified discovery from formula directory
    return discoverMdFilesUnified(formulaDir, formulaName);
  }
}

/**
 * Dedupe discovered files by source fullPath, preferring universal subdirs over ai
 */
export function dedupeDiscoveredFilesPreferUniversal(files: DiscoveredFile[]): DiscoveredFile[] {
  const preference = (registryPath: string): number => {
    if (registryPath.startsWith(`${UNIVERSAL_SUBDIRS.RULES}/`) || registryPath === UNIVERSAL_SUBDIRS.RULES) return 3;
    if (registryPath.startsWith(`${UNIVERSAL_SUBDIRS.COMMANDS}/`) || registryPath === UNIVERSAL_SUBDIRS.COMMANDS) return 3;
    if (registryPath.startsWith(`${UNIVERSAL_SUBDIRS.AGENTS}/`) || registryPath === UNIVERSAL_SUBDIRS.AGENTS) return 3;
    if (registryPath.startsWith(`${PLATFORM_DIRS.AI}/`) || registryPath === PLATFORM_DIRS.AI) return 2;
    return 1;
  };

  const map = new Map<string, DiscoveredFile>();
  for (const file of files) {
    const existing = map.get(file.fullPath);
    if (!existing) {
      map.set(file.fullPath, file);
      continue;
    }
    if (preference(file.registryPath) > preference(existing.registryPath)) {
      map.set(file.fullPath, file);
    }
  }
  return Array.from(map.values());
}

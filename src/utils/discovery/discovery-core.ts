import { join, isAbsolute } from 'path';
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
import { exists } from '../fs.js';
import { normalizePathForProcessing } from '../path-normalization.js';

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
    const dummyPath = join(directoryPath, 'dummy.md');
    const mapping = mapPlatformFileToUniversal(dummyPath); // Use dummy file to get path mapping
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
 * Resolve the source directory based on directory path
 * @param directoryPath - The directory path to resolve
 * @returns Promise resolving to the resolved source directory path
 */
async function resolveSourceDirectory(directoryPath: string): Promise<string> {
  if (isAbsolute(directoryPath)) {
    return directoryPath;
  } else {
    return join(process.cwd(), directoryPath);
  }
}

/**
 * Add global frontmatter matches to results and dedupe
 * @param results - Current discovered files
 * @param formulaDir - Path to the formula directory
 * @param formulaName - Name of the formula
 * @returns Promise resolving to deduplicated array of discovered files
 */
async function addGlobalMatches(
  results: DiscoveredFile[],
  formulaDir: string,
  formulaName: string
): Promise<DiscoveredFile[]> {
  const globalFiles = await discoverMdFilesUnified(formulaDir, formulaName);
  results.push(...globalFiles);
  return dedupeDiscoveredFilesPreferUniversal(results);
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
  formulaName: string,
  directoryPath?: string
): Promise<DiscoveredFile[]> {
  // No directory path: use unified discovery from formula directory
  if (!directoryPath) {
    return discoverMdFilesUnified(formulaDir, formulaName);
  }

  // Directory path provided: discover files from that directory
  const sourceDir = await resolveSourceDirectory(directoryPath);
  const platformInfo = parsePlatformDirectory(directoryPath);
  const results: DiscoveredFile[] = [];

  if (platformInfo) {
    // Platform-specific directory: search for direct md files only
    const directFiles = await discoverDirectMdFiles(sourceDir, formulaName, platformInfo);
    results.push(...directFiles);

    // Exclude accidental ai/ mappings when using a platform-specific directory
    const filteredResults = results.filter((f) => {
      const normalizedRegistryPath = normalizePathForProcessing(f.registryPath);
      return !(normalizedRegistryPath === PLATFORM_DIRS.AI || normalizedRegistryPath.startsWith(`${PLATFORM_DIRS.AI}/`));
    });

    // Add global frontmatter matches
    return addGlobalMatches(filteredResults, formulaDir, formulaName);
  }

  // Non-platform directory: search for platform subdirectories + direct files
  const platformSubdirFiles = await discoverMdFilesUnified(formulaDir, formulaName, undefined, true);
  results.push(...platformSubdirFiles);

  const directFiles = await discoverDirectMdFiles(sourceDir, formulaName, null);
  results.push(...directFiles);

  // Add global frontmatter matches
  return addGlobalMatches(results, formulaDir, formulaName);
}

/**
 * Dedupe discovered files by source fullPath, preferring universal subdirs over ai
 */
export function dedupeDiscoveredFilesPreferUniversal(files: DiscoveredFile[]): DiscoveredFile[] {
  const preference = (registryPath: string): number => {
    // Normalize registry path to use forward slashes for consistent comparison
    const normalizedPath = normalizePathForProcessing(registryPath);

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
    if (preference(file.registryPath) > preference(existing.registryPath)) {
      map.set(file.fullPath, file);
    }
  }
  return Array.from(map.values());
}

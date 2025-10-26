import { join } from 'path';
import { PLATFORM_AI, PLATFORM_DIRS, UNIVERSAL_SUBDIRS } from '../../constants/index.js';
import { exists, isDirectory } from '../../utils/fs.js';
import {
  getPlatformDefinition,
} from '../../core/platforms.js';
import type { DiscoveredFile } from '../../types/index.js';

// Import the shared type
import { buildPlatformSearchConfig, PlatformSearchConfig } from './platform-discovery.js';
import { discoverFiles } from './file-discovery.js';
import { normalizePathForProcessing } from '../../utils/path-normalization.js';

/**
 * Process platform subdirectories (rules/commands/agents) within a base directory
 * Common logic shared between different discovery methods
 */
async function discoverPlatformFiles(
  config: PlatformSearchConfig,
  formulaName: string,
): Promise<DiscoveredFile[]> {

  // Handle AI directory separately - does not contain platform subdirectory structure
  if (config.platform === PLATFORM_AI) {
    return discoverFiles(
      PLATFORM_DIRS.AI,
      formulaName,
      config.platform,
      PLATFORM_DIRS.AI, // AI directory uses 'ai' prefix
    );
  }

  const definition = getPlatformDefinition(config.platform);
  const allFiles: DiscoveredFile[] = [];

  // Process each universal subdir that this platform supports
  for (const [subdirName, subdirDef] of Object.entries(definition.subdirs)) {
    const subdirPath = join(config.rootDir, subdirDef.path);

    if (await exists(subdirPath) && await isDirectory(subdirPath)) {
      const files = await discoverFiles(
        subdirPath,
        formulaName,
        config.platform,
        subdirName, // Universal registry path
      );
      allFiles.push(...files);
    }
  }

  return allFiles;
}

/**
 * Dedupe discovered files by source fullPath, preferring universal subdirs over ai
 */
function dedupeDiscoveredFilesPreferUniversal(files: DiscoveredFile[]): DiscoveredFile[] {
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

/**
 * Unified file discovery function that searches platform-specific directories
 */
export async function discoverPlatformFilesUnified(cwd: string, formulaName: string): Promise<DiscoveredFile[]> {
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  const allDiscoveredFiles: DiscoveredFile[] = [];

  // Process all platform configurations in parallel
  const discoveryPromises = platformConfigs.map(async (config) => {
    return discoverPlatformFiles(config, formulaName);
  });

  const discoveredFiles = await Promise.all(discoveryPromises);
  allDiscoveredFiles.push(...discoveredFiles.flat());

  return dedupeDiscoveredFilesPreferUniversal(allDiscoveredFiles);
}

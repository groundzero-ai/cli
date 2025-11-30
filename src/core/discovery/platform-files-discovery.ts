import { join } from 'path';
import { exists, isDirectory } from '../../utils/fs.js';
import {
  getPlatformDefinition,
  getDetectedPlatforms,
  isUniversalSubdirPath,
  type Platform
} from '../../core/platforms.js';
import type { DiscoveredFile } from '../../types/index.js';

import { discoverFiles } from './file-discovery.js';
import { normalizePathForProcessing } from '../../utils/path-normalization.js';
import { WORKSPACE_DISCOVERY_EXCLUDES } from '../../constants/workspace.js';

/**
 * Process platform subdirectories (rules/commands/agents) within a base directory
 * Common logic shared between different discovery methods
 */
async function discoverPlatformFiles(
  cwd: string,
  platform: Platform,
  packageName: string
): Promise<DiscoveredFile[]> {
  const definition = getPlatformDefinition(platform);
  const allFiles: DiscoveredFile[] = [];

  // Process each universal subdir that this platform supports
  for (const [subdirName, subdirDef] of Object.entries(definition.subdirs)) {
    if (!subdirDef) {
      continue;
    }
    const subdirPath = join(cwd, definition.rootDir, subdirDef.path);
    const allowedExts = subdirDef.exts;

    if (allowedExts && allowedExts.length === 0) {
      continue;
    }

    if (await exists(subdirPath) && await isDirectory(subdirPath)) {
      const files = await discoverFiles(
        subdirPath,
        packageName,
        {
          platform,
          registryPathPrefix: subdirName,
          sourceDirLabel: platform,
          fileExtensions: allowedExts
        }
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
    // Normalize registry path to use forward slashes for consistent comparison
    const normalizedPath = normalizePathForProcessing(file.registryPath);

    if (isUniversalSubdirPath(normalizedPath)) return 2;
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
async function discoverWorkspaceFiles(cwd: string, packageName: string): Promise<DiscoveredFile[]> {
  return await discoverFiles(cwd, packageName, {
    registryPathPrefix: '',
    sourceDirLabel: 'workspace',
    excludeDirs: WORKSPACE_DISCOVERY_EXCLUDES,
    fileExtensions: []
  });
}

export async function discoverPlatformFilesUnified(cwd: string, packageName: string): Promise<DiscoveredFile[]> {
  const detectedPlatforms = await getDetectedPlatforms(cwd);
  const allDiscoveredFiles: DiscoveredFile[] = [];

  // Process all platform configurations in parallel
  const discoveryPromises = detectedPlatforms.map(async (platform) => {
    return discoverPlatformFiles(cwd, platform, packageName);
  });

  const discoveredFiles = await Promise.all(discoveryPromises);
  allDiscoveredFiles.push(...discoveredFiles.flat());

  const workspaceDiscovered = await discoverWorkspaceFiles(cwd, packageName);
  allDiscoveredFiles.push(...workspaceDiscovered);

  return dedupeDiscoveredFilesPreferUniversal(allDiscoveredFiles);
}

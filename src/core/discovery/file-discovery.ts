import { join } from 'path';
import type { Platform } from '../platforms.js';
import { getPlatformDefinition } from '../platforms.js';
import { mapPlatformFileToUniversal } from '../../utils/platform-mapper.js';
import { exists, isDirectory } from '../../utils/fs.js';
import { DiscoveredFile } from '../../types';
import { discoverMdFiles } from './md-files-discovery.js';

export interface DiscoveryPathContext {
  platform?: Platform;
  registryPathPrefix?: string;
  sourceDirLabel?: string;
  excludeDirs?: Set<string>;
}

export async function obtainSourceDirAndRegistryPath(
  file: { fullPath: string; relativePath: string },
  context: DiscoveryPathContext = {}
): Promise<{ sourceDir: string; registryPath: string }> {
  const fallbackPath = context.registryPathPrefix
    ? join(context.registryPathPrefix, file.relativePath)
    : file.relativePath;

  if (context.platform) {
    const mapping = mapPlatformFileToUniversal(file.fullPath);
    const registryPath = mapping ? join(mapping.subdir, mapping.relPath) : fallbackPath;
    const sourceDir = context.sourceDirLabel ?? getPlatformDefinition(context.platform).rootDir;
    return { sourceDir, registryPath };
  }

  return {
    sourceDir: context.sourceDirLabel ?? (context.registryPathPrefix || 'workspace'),
    registryPath: fallbackPath
  };
}

export async function discoverFiles(
  rootDir: string,
  packageName: string,
  context: DiscoveryPathContext
): Promise<DiscoveredFile[]> {
  if (!(await exists(rootDir)) || !(await isDirectory(rootDir))) {
    return [];
  }

  return await discoverMdFiles(rootDir, packageName, context);
}

/**
 * Discover markdown files in a directory with specified patterns and inclusion rules
 */
// export async function discoverFiles(
//   directoryPath: string,
//   packageName: string,
//   platform: Platformish,
//   registryPathPrefix: string = '',
// ): Promise<DiscoveredFile[]> {

//   if (!(await exists(directoryPath)) || !(await isDirectory(directoryPath))) {
//     return [];
//   }

//   // Find files with the specified patterns
//   const allFiles: Array<{ fullPath: string; relativePath: string }> = [];

//   // Recursive search using findFilesByExtension
//   const files = await findFilesByExtension(directoryPath, filePatterns);
//   allFiles.push(...files);

//   // Process files in parallel using the extracted helper
//   const processPromises = allFiles.map(async (file) =>
//     processMdFileForDiscovery(file, packageName, platform, registryPathPrefix)
//   );

//   const results = await Promise.all(processPromises);
//   return results.filter((result): result is DiscoveredFile => result !== null);
// }

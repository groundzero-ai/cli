import { join } from 'path';
import type { Platform } from '../platforms.js';
import { getPlatformDefinition } from '../platforms.js';
import { mapPlatformFileToUniversal } from '../../utils/platform-mapper.js';
import { exists, isDirectory, readTextFile } from '../../utils/fs.js';
import { DiscoveredFile } from '../../types';
import { getFileMtime, findFilesByExtension } from '../../utils/file-processing.js';
import { calculateFileHash } from '../../utils/hash-utils.js';
import { logger } from '../../utils/logger.js';

export interface DiscoveryPathContext {
  platform?: Platform;
  registryPathPrefix?: string;
  sourceDirLabel?: string;
  excludeDirs?: Set<string>;
  /**
   * Optional list of file extensions to consider when discovering files.
   * - undefined -> include all files
   * - [] -> include all files
   * - ['.toml'] -> include only matching extensions
   */
  fileExtensions?: string[];
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

  const fileExtensions = context.fileExtensions ?? [];
  const files = await findFilesByExtension(rootDir, fileExtensions, rootDir, {
    excludeDirs: context.excludeDirs
  });

  const processPromises = files.map(async (file) =>
    processFileForDiscovery(file, packageName, context)
  );

  const results = await Promise.all(processPromises);
  return results.filter((result): result is DiscoveredFile => result !== null);
}

async function processFileForDiscovery(
  file: { fullPath: string; relativePath: string },
  packageName: string,
  context: DiscoveryPathContext
): Promise<DiscoveredFile | null> {
  try {
    const content = await readTextFile(file.fullPath);

    try {
      const mtime = await getFileMtime(file.fullPath);
      const contentHash = await calculateFileHash(content);
      const { sourceDir, registryPath } = await obtainSourceDirAndRegistryPath(file, context);

      return {
        fullPath: file.fullPath,
        relativePath: file.relativePath,
        sourceDir,
        registryPath,
        mtime,
        contentHash
      };
    } catch (error) {
      logger.warn(`Failed to process file metadata for ${file.relativePath}: ${error}`);
    }
  } catch (error) {
    logger.warn(`Failed to read ${file.relativePath}: ${error}`);
  }

  return null;
}

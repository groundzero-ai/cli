import { join } from 'path';
import { parseMarkdownFrontmatter } from '../md-frontmatter.js';
import { FILE_PATTERNS, PLATFORM_DIRS } from '../../constants/index.js';
import { logger } from '../logger.js';
import {
  exists,
  readTextFile,
  listFiles,
  listDirectories,
  isDirectory
} from '../fs.js';
import { calculateFileHash } from '../hash-utils.js';
import { mapPlatformFileToUniversal } from '../platform-mapper.js';
import { getRelativePathFromBase } from '../path-normalization.js';
import type { DiscoveredFile } from '../../types/index.js';
import { getPlatformDefinition, type Platform } from '../../core/platforms.js';
import { shouldIncludeMarkdownFile } from '../../core/discovery/md-files-discovery.js';

// Union type for modules that need to handle AI directory alongside platforms
export type Platformish = Platform | typeof PLATFORM_DIRS.AI;

/**
 * Get file modification time
 * @throws Error if unable to get file stats
 */
export async function getFileMtime(filePath: string): Promise<number> {
  const { getStats } = await import('../fs.js');
  const stats = await getStats(filePath);
  return stats.mtime.getTime();
}

/**
 * Recursively find files by extension in a directory
 */
export async function findFilesByExtension(
  dir: string,
  extensions: string[] = [],
  baseDir: string = dir
): Promise<Array<{ fullPath: string; relativePath: string }>> {
  if (!(await exists(dir)) || !(await isDirectory(dir))) {
    return [];
  }

  const files: Array<{ fullPath: string; relativePath: string }> = [];
  const normalizedExtensions = extensions.map(extension => extension.startsWith('.') ? extension : `.${extension}`);

  // Check current directory files
  const dirFiles = await listFiles(dir);
  for (const file of dirFiles) {
    // If no extension is provided, include all files
    // Otherwise, include only files with the specified extension
    if (normalizedExtensions.length === 0 || normalizedExtensions.some(extension => file.endsWith(extension))) {
      const fullPath = join(dir, file);
      const relativePath = getRelativePathFromBase(fullPath, baseDir);
      files.push({ fullPath, relativePath });
    }
  }

  // Recursively search subdirectories
  const subdirs = await listDirectories(dir);
  const subFilesPromises = subdirs.map(subdir =>
    findFilesByExtension(join(dir, subdir), extensions, baseDir)
  );
  const subFiles = await Promise.all(subFilesPromises);
  files.push(...subFiles.flat());

  return files;
}

/**
 * Process a single markdown file for discovery - common logic used by multiple discovery methods
 */
export async function processMdFileForDiscovery(
  file: { fullPath: string; relativePath: string },
  formulaName: string,
  platform: Platformish,
  registryPathPrefix: string,
): Promise<DiscoveredFile | null> {
  try {
    const content = await readTextFile(file.fullPath);
    let frontmatter;
    try {
      frontmatter = parseMarkdownFrontmatter(content);
    } catch (parseError) {
      logger.warn(`Failed to parse frontmatter in ${file.relativePath}: ${parseError}`);
      frontmatter = null;
    }

    const shouldInclude = shouldIncludeMarkdownFile(file, frontmatter, platform, formulaName);

    if (shouldInclude) {
      try {
        const mtime = await getFileMtime(file.fullPath);
        const contentHash = await calculateFileHash(content);

        // Compute registry path using new universal mapping
        let registryPath: string;
        if (platform !== 'ai') {
          // Universal file from platform directory - use the mapper to get universal path
          const mapping = mapPlatformFileToUniversal(file.fullPath);
          if (mapping) {
            registryPath = join(mapping.subdir, mapping.relPath);
          } else {
            // Fallback to old logic
            registryPath = registryPathPrefix ? join(registryPathPrefix, file.relativePath) : file.relativePath;
          }
        } else {
          // Platform-specific file or directory mode - use normal registry path logic
          registryPath = registryPathPrefix ? join(registryPathPrefix, file.relativePath) : file.relativePath;
        }

        const sourceDir = platform === 'ai' ? PLATFORM_DIRS.AI : getPlatformDefinition(platform).rootDir;
        const result: DiscoveredFile = {
          fullPath: file.fullPath,
          relativePath: file.relativePath,
          sourceDir,
          registryPath,
          mtime,
          contentHash
        };

        if (frontmatter?.formula?.platformSpecific === true) {
          result.forcePlatformSpecific = true;
        }

        return result;
      } catch (error) {
        logger.warn(`Failed to process file metadata for ${file.relativePath}: ${error}`);
      }
    }
  } catch (error) {
    logger.warn(`Failed to read ${file.relativePath}: ${error}`);
  }
  return null;
}
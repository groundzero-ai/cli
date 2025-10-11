import { join } from 'path';
import { parseMarkdownFrontmatter } from '../md-frontmatter.js';
import { detectTemplateFile } from '../template.js';
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
import type { DiscoveredFile } from '../../types/index.js';
import type { Platform } from '../../core/platforms.js';

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
  extension: string,
  baseDir: string = dir
): Promise<Array<{ fullPath: string; relativePath: string }>> {
  if (!(await exists(dir)) || !(await isDirectory(dir))) {
    return [];
  }

  const files: Array<{ fullPath: string; relativePath: string }> = [];

  // Check current directory files
  const dirFiles = await listFiles(dir);
  for (const file of dirFiles) {
    if (file.endsWith(extension)) {
      const fullPath = join(dir, file);
      const relativePath = fullPath.substring(baseDir.length + 1);
      files.push({ fullPath, relativePath });
    }
  }

  // Recursively search subdirectories
  const subdirs = await listDirectories(dir);
  const subFilesPromises = subdirs.map(subdir =>
    findFilesByExtension(join(dir, subdir), extension, baseDir)
  );
  const subFiles = await Promise.all(subFilesPromises);
  files.push(...subFiles.flat());

  return files;
}

/**
 * Process a single file for discovery - common logic used by multiple discovery methods
 */
export async function processFileForDiscovery(
  file: { fullPath: string; relativePath: string },
  formulaName: string,
  platformName: Platformish,
  registryPathPrefix: string,
  inclusionMode: 'directory' | 'platform',
  formulaDir?: string,
  shouldIncludeMarkdownFile?: (file: { relativePath: string }, frontmatter: any, sourceDir: Platformish, formulaName: string, formulaDirRelativeToAi?: string, isDirectoryMode?: boolean) => boolean
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

    const shouldInclude = inclusionMode === 'directory'
      ? (!frontmatter || !frontmatter.formula || frontmatter?.formula?.name === formulaName || !frontmatter?.formula?.name)
      : shouldIncludeMarkdownFile ? shouldIncludeMarkdownFile(file, frontmatter, platformName, formulaName, formulaDir, inclusionMode === 'platform') : true;

    if (shouldInclude) {
      // Skip template files
      if (detectTemplateFile(content)) {
        logger.debug(`Skipping template file: ${file.relativePath}`);
        return null;
      }

      try {
        const mtime = await getFileMtime(file.fullPath);
        const contentHash = await calculateFileHash(content);

        // Compute registry path using new universal mapping
        let registryPath: string;
        if (inclusionMode === 'platform' && platformName !== PLATFORM_DIRS.AI && frontmatter?.formula?.name === formulaName) {
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

        const result: DiscoveredFile = {
          fullPath: file.fullPath,
          relativePath: file.relativePath,
          sourceDir: platformName,
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

/**
 * Discover markdown files in a directory with specified patterns and inclusion rules
 */
export async function discoverFiles(
  directoryPath: string,
  formulaName: string,
  platformName: Platformish,
  registryPathPrefix: string = '',
  filePatterns: string[] = [FILE_PATTERNS.MD_FILES],
  inclusionMode: 'directory' | 'platform' = 'directory',
  formulaDir?: string,
  recursive: boolean = true,
  shouldIncludeMarkdownFile?: (file: { relativePath: string }, frontmatter: any, sourceDir: Platformish, formulaName: string, formulaDirRelativeToAi?: string, isDirectoryMode?: boolean) => boolean
): Promise<DiscoveredFile[]> {
  if (!(await exists(directoryPath)) || !(await isDirectory(directoryPath))) {
    return [];
  }

  // Find files with the specified patterns
  const allFiles: Array<{ fullPath: string; relativePath: string }> = [];

  if (recursive) {
    // Recursive search using findFilesByExtension
    for (const pattern of filePatterns) {
      const extension = pattern.startsWith('.') ? pattern : `.${pattern}`;
      const files = await findFilesByExtension(directoryPath, extension, directoryPath);
      allFiles.push(...files);
    }
  } else {
    // Shallow search - only immediate directory files
    const dirFiles = await listFiles(directoryPath);
    for (const file of dirFiles) {
      // Skip directories - we only want immediate files
      const filePath = join(directoryPath, file);
      if (await isDirectory(filePath)) {
        continue;
      }

      // Check if file matches patterns
      let matchesPattern = false;
      for (const pattern of filePatterns) {
        const extension = pattern.startsWith('.') ? pattern : `.${pattern}`;
        if (file.endsWith(extension)) {
          matchesPattern = true;
          break;
        }
      }

      if (matchesPattern) {
        const fullPath = filePath;
        const relativePath = file; // since we're only in the immediate directory
        allFiles.push({ fullPath, relativePath });
      }
    }
  }

  // Process files in parallel using the extracted helper
  const processPromises = allFiles.map(async (file) =>
    processFileForDiscovery(file, formulaName, platformName, registryPathPrefix, inclusionMode, formulaDir, shouldIncludeMarkdownFile)
  );

  const results = await Promise.all(processPromises);
  return results.filter((result): result is DiscoveredFile => result !== null);
}

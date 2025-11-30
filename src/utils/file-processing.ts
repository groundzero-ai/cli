import { join } from 'path';
import { logger } from './logger.js';
import {
  exists,
  listFiles,
  listDirectories,
  isDirectory,
  getStats
} from './fs.js';
import { getRelativePathFromBase } from './path-normalization.js';

/**
 * Get file modification time
 * @throws Error if unable to get file stats
 */
export async function getFileMtime(filePath: string): Promise<number> {
  const stats = await getStats(filePath);
  return stats.mtime.getTime();
}

/**
 * Recursively find files by extension in a directory
 */
export async function findFilesByExtension(
  dir: string,
  extensions: string[] = [],
  baseDir: string = dir,
  options: { excludeDirs?: Set<string> } = {}
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
  const subFilesPromises = subdirs
    .filter(subdir => !(options.excludeDirs && options.excludeDirs.has(subdir)))
    .map(subdir =>
      findFilesByExtension(join(dir, subdir), extensions, baseDir, options)
    );
  const subFiles = await Promise.all(subFilesPromises);
  files.push(...subFiles.flat());

  return files;
}

/**
 * Recursively find directories containing a specific file
 * @param rootDir - Root directory to start searching from
 * @param targetFileName - Name of the file to search for (e.g., 'package.yml')
 * @param parseCallback - Optional callback to parse and validate the file content
 * @returns Array of directory paths where the file was found
 */
export async function findDirectoriesContainingFile<T = void>(
  rootDir: string,
  targetFileName: string,
  parseCallback?: (filePath: string) => Promise<T | null>
): Promise<Array<{ dirPath: string; parsedContent?: T }>> {
  const results: Array<{ dirPath: string; parsedContent?: T }> = [];

  if (!(await exists(rootDir)) || !(await isDirectory(rootDir))) {
    return results;
  }

  async function recurse(dir: string): Promise<void> {
    try {
      const files = await listFiles(dir);

      // Check if target file exists in current directory
      if (files.includes(targetFileName)) {
        const filePath = join(dir, targetFileName);

        // If parse callback provided, use it to validate/parse
        if (parseCallback) {
          try {
            const parsedContent = await parseCallback(filePath);
            if (parsedContent !== null) {
              results.push({ dirPath: dir, parsedContent });
            }
          } catch (error) {
            logger.warn(`Failed to parse ${targetFileName} at ${filePath}: ${error}`);
          }
        } else {
          // No callback, just record the directory
          results.push({ dirPath: dir });
        }
      }

      // Recursively search subdirectories
      const subdirs = await listDirectories(dir);
      for (const subdir of subdirs) {
        const subdirPath = join(dir, subdir);
        await recurse(subdirPath);
      }
    } catch (error) {
      logger.warn(`Failed to scan directory: ${dir}`, { error });
    }
  }

  await recurse(rootDir);
  return results;
}

import { promises as fs, constants as fsConstants, Stats } from 'fs';
import { join, dirname, relative } from 'path';
import { logger } from './logger.js';
import { FileSystemError } from './errors.js';

/**
 * File system utilities with proper error handling
 */

/**
 * Check if a file or directory exists
 */
export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a path is a directory
 */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if a path is a file
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Recursively create directories
 */
export async function ensureDir(path: string): Promise<void> {
  try {
    await fs.mkdir(path, { recursive: true });
    logger.debug(`Directory located or created: ${path}`);
  } catch (error) {
    throw new FileSystemError(`Failed to locate or create directory: ${path}`, { path, error });
  }
}

/**
 * Read a file as text
 */
export async function readTextFile(path: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
  try {
    return await fs.readFile(path, encoding);
  } catch (error) {
    throw new FileSystemError(`Failed to read file: ${path}`, { path, error });
  }
}

/**
 * Write text to a file
 */
export async function writeTextFile(path: string, content: string, encoding: BufferEncoding = 'utf8'): Promise<void> {
  try {
    await ensureDir(dirname(path));
    await fs.writeFile(path, content, encoding);
    logger.debug(`Wrote file: ${path}`);
  } catch (error) {
    throw new FileSystemError(`Failed to write file: ${path}`, { path, error });
  }
}

/**
 * Copy a file from source to destination
 */
export async function copyFile(src: string, dest: string): Promise<void> {
  try {
    await ensureDir(dirname(dest));
    await fs.copyFile(src, dest);
    logger.debug(`Copied file: ${src} -> ${dest}`);
  } catch (error) {
    throw new FileSystemError(`Failed to copy file: ${src} -> ${dest}`, { src, dest, error });
  }
}

/**
 * Remove a file or directory recursively
 */
export async function remove(path: string): Promise<void> {
  try {
    const stats = await fs.stat(path);
    if (stats.isDirectory()) {
      await fs.rm(path, { recursive: true });
    } else {
      await fs.unlink(path);
    }
    logger.debug(`Removed: ${path}`);
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      // File doesn't exist, which is fine
      return;
    }
    throw new FileSystemError(`Failed to remove: ${path}`, { path, error });
  }
}

/**
 * List files in a directory (non-recursive)
 */
export async function listFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile())
      .map(entry => entry.name);
  } catch (error) {
    throw new FileSystemError(`Failed to list files in directory: ${dirPath}`, { dirPath, error });
  }
}

/**
 * List directories in a directory (non-recursive)
 */
export async function listDirectories(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch (error) {
    throw new FileSystemError(`Failed to list directories in directory: ${dirPath}`, { dirPath, error });
  }
}

/**
 * Recursively remove empty directories under a root (but not the root itself)
 */
export async function removeEmptyDirectories(root: string): Promise<void> {
  async function recurse(dir: string): Promise<boolean> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const child = join(dir, entry.name);
        await recurse(child);
      }
    }
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
      if (entries.length === 0 && dir !== root) {
        await remove(dir);
        return true;
      }
    } catch {}
    return false;
  }
  await recurse(root);
}

/**
 * Recursively walk through a directory and yield all files
 */
export async function* walkFiles(dirPath: string, includePatterns: string[] = []): AsyncGenerator<string> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const relativePath = relative(process.cwd(), fullPath);
      
      if (entry.isFile()) {
        // If include patterns are specified, check if this file matches any of them
        if (includePatterns.length > 0) {
          const shouldInclude = includePatterns.some(pattern => {
            // Simple glob pattern matching (could be enhanced with a proper glob library)
            const regex = new RegExp(pattern.replace(/\*/g, '.*').replace(/\?/g, '.'));
            return regex.test(relativePath) || regex.test(entry.name);
          });
          
          if (shouldInclude) {
            yield fullPath;
          }
        } else {
          // If no include patterns specified, include all files
          yield fullPath;
        }
      } else if (entry.isDirectory()) {
        yield* walkFiles(fullPath, includePatterns);
      }
    }
  } catch (error) {
    throw new FileSystemError(`Failed to walk directory: ${dirPath}`, { dirPath, error });
  }
}

/**
 * Get file stats
 */
export async function getStats(path: string): Promise<Stats> {
  try {
    return await fs.stat(path);
  } catch (error) {
    throw new FileSystemError(`Failed to get stats for: ${path}`, { path, error });
  }
}

/**
 * Read JSON file and parse it
 */
export async function readJsonFile<T = any>(path: string): Promise<T> {
  try {
    const content = await readTextFile(path);
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof FileSystemError) {
      throw error;
    }
    throw new FileSystemError(`Failed to parse JSON file: ${path}`, { path, error });
  }
}

/**
 * Write object to JSON file
 */
export async function writeJsonFile(path: string, data: any, indent: number = 2): Promise<void> {
  try {
    const content = JSON.stringify(data, null, indent);
    await writeTextFile(path, content);
  } catch (error) {
    throw new FileSystemError(`Failed to write JSON file: ${path}`, { path, error });
  }
}

/**
 * Rename a directory (or file) from source path to destination path.
 * Ensures the destination parent directory exists and wraps errors consistently.
 */
export async function renameDirectory(srcPath: string, destPath: string): Promise<void> {
  try {
    await ensureDir(dirname(destPath));
    await fs.rename(srcPath, destPath);
    logger.debug(`Renamed: ${srcPath} -> ${destPath}`);
  } catch (error) {
    throw new FileSystemError(`Failed to rename: ${srcPath} -> ${destPath}`, { srcPath, destPath, error });
  }
}

/**
 * Get the total size of a directory recursively
 */
export async function getDirectorySize(dirPath: string): Promise<number> {
  try {
    let totalSize = 0;
    
    for await (const filePath of walkFiles(dirPath)) {
      try {
        const stats = await getStats(filePath);
        totalSize += stats.size;
      } catch (error) {
        // Skip files that can't be accessed
        logger.debug(`Failed to get size for file: ${filePath}`, { error });
      }
    }
    
    return totalSize;
  } catch (error) {
    throw new FileSystemError(`Failed to calculate directory size: ${dirPath}`, { dirPath, error });
  }
}

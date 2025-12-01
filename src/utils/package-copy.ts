import { join, relative, dirname } from 'path';

import type { PackageFile } from '../types/index.js';
import { PACKAGE_INDEX_FILENAME } from './package-index-yml.js';
import {
  exists,
  ensureDir,
  readTextFile,
  writeTextFile,
  walkFiles,
  remove
} from './fs.js';
import { logger } from './logger.js';
import { normalizePathForProcessing } from './path-normalization.js';

/**
 * Directory prefixes to exclude when copying package contents.
 * These paths are relative to the package root directory.
 */
const EXCLUDED_DIR_PREFIXES = [
  'packages' // Nested packages are independent units; never copy inline
];

/**
 * File names to exclude from copies.
 */
const EXCLUDED_FILES = new Set<string>([PACKAGE_INDEX_FILENAME]);

/**
 * Check whether a relative path (from package root) should be excluded
 * from being copied to the registry or local package cache.
 */
export function isExcludedFromPackage(relativePath: string): boolean {
  const normalized = normalizePathForProcessing(relativePath);

  // Check direct file exclusions (e.g., package.index.yml)
  const baseName = normalized.split('/').pop();
  if (baseName && EXCLUDED_FILES.has(baseName)) {
    return true;
  }

  // Check directory prefixes (e.g., packages/**)
  return EXCLUDED_DIR_PREFIXES.some(prefix => {
    const normalizedPrefix = normalizePathForProcessing(prefix);
    return (
      normalized === normalizedPrefix ||
      normalized.startsWith(`${normalizedPrefix}/`)
    );
  });
}

/**
 * Read package files from disk (workspace or local cache) applying
 * exclusion filters so the result represents the canonical registry payload.
 */
export async function readPackageFilesForRegistry(packageDir: string): Promise<PackageFile[]> {
  const files: PackageFile[] = [];

  if (!(await exists(packageDir))) {
    return files;
  }

  for await (const fullPath of walkFiles(packageDir)) {
    const relativePath = normalizePathForProcessing(relative(packageDir, fullPath));

    if (isExcludedFromPackage(relativePath)) {
      logger.debug(`Skipping excluded package path: ${relativePath}`);
      continue;
    }

    const content = await readTextFile(fullPath);
    files.push({
      path: relativePath,
      content,
      encoding: 'utf8'
    });
  }

  return files;
}

/**
 * Write package files to a destination directory. Existing files that are not
 * part of the package payload are removed to keep the directory in sync.
 */
export async function writePackageFilesToDirectory(
  targetDir: string,
  files: PackageFile[],
  options: { preserveIndexFile?: boolean } = {}
): Promise<void> {
  await ensureDir(targetDir);

  const filesToKeep = new Set<string>(
    files.map(file => normalizePathForProcessing(file.path))
  );

  if (options.preserveIndexFile) {
    filesToKeep.add(PACKAGE_INDEX_FILENAME);
  }

  if (await exists(targetDir)) {
    for await (const fullPath of walkFiles(targetDir)) {
      const relPath = normalizePathForProcessing(relative(targetDir, fullPath));

      if (!filesToKeep.has(relPath) && !isExcludedFromPackage(relPath)) {
        try {
          await remove(fullPath);
          logger.debug(`Removed stale package file: ${relPath}`);
        } catch (error) {
          logger.warn(`Failed to remove stale package file ${relPath}: ${error}`);
        }
      }
    }
  }

  await Promise.all(
    files.map(async file => {
      const targetPath = join(targetDir, file.path);
      await ensureDir(dirname(targetPath));
      await writeTextFile(targetPath, file.content, (file.encoding as BufferEncoding) ?? 'utf8');
    })
  );
}



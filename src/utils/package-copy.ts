/**
 * Package file I/O utilities for reading from and writing to package directories.
 *
 * This module provides two main operations:
 *   - readPackageFilesForRegistry: Collect files from a package directory into a
 *     registry-ready payload, applying static exclusions and manifest-based filters.
 *   - writePackageFilesToDirectory: Write a set of PackageFile entries to disk,
 *     syncing the directory contents (removing stale files).
 */

import { join, relative, dirname } from 'path';

import type { PackageFile } from '../types/index.js';
import { DIR_PATTERNS, FILE_PATTERNS } from '../constants/index.js';
import { getAllPlatforms, getPlatformDefinition } from '../core/platforms.js';
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
import { parsePackageYml } from './package-yml.js';
import { createPackageFileFilter, isExcludedFromPackage } from './package-filters.js';

interface ManifestInfo {
  fullPath: string;
  relativePath: string;
}

interface DefaultIncludeConfig {
  includePatterns: string[];
  hardIncludeFiles: Set<string>;
}

const MANIFEST_RELATIVE_PATHS = Object.freeze([
  FILE_PATTERNS.PACKAGE_YML,
  `${DIR_PATTERNS.OPENPACKAGE}/${FILE_PATTERNS.PACKAGE_YML}`
]);

// ─────────────────────────────────────────────────────────────────────────────
// Reading package files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read package files from disk and return a registry-ready payload.
 *
 * Applies two layers of filtering:
 *   1. Static exclusions (package.index.yml, packages/** nested dirs).
 *   2. Manifest-based include/exclude patterns from package.yml.
 *
 * @param packageDir - Absolute path to the package root directory.
 * @returns Array of PackageFile entries representing the canonical payload.
 */
export async function readPackageFilesForRegistry(packageDir: string): Promise<PackageFile[]> {
  if (!(await exists(packageDir))) {
    return [];
  }

  const manifestFilter = await loadManifestFilter(packageDir);
  const files: PackageFile[] = [];

  for await (const fullPath of walkFiles(packageDir)) {
    const relativePath = normalizePathForProcessing(relative(packageDir, fullPath));

    // Layer 1: static exclusions (always enforced)
    if (isExcludedFromPackage(relativePath)) {
      logger.debug(`Skipping static-excluded path: ${relativePath}`);
      continue;
    }

    // Layer 2: manifest-based include/exclude
    if (!manifestFilter(relativePath)) {
      logger.debug(`Skipping path by manifest filter: ${relativePath}`);
      continue;
    }

    const content = await readTextFile(fullPath);
    files.push({ path: relativePath, content, encoding: 'utf8' });
  }

  return files;
}

/**
 * Build a filter function from the package.yml include/exclude fields.
 * Returns a pass-all filter if no manifest or no patterns are defined.
 */
async function loadManifestFilter(packageDir: string): Promise<(path: string) => boolean> {
  const manifestInfo = await findPackageManifest(packageDir);

  let manifestConfigInclude: string[] | undefined;
  let manifestConfigExclude: string[] | undefined;

  if (manifestInfo) {
    try {
      const config = await parsePackageYml(manifestInfo.fullPath);
      manifestConfigInclude = config.include;
      manifestConfigExclude = config.exclude;
    } catch (error) {
      logger.warn(`Failed to load manifest filters from ${manifestInfo.fullPath}: ${String(error)}`);
    }
  }

  const defaults = await buildDefaultIncludeConfig(packageDir, manifestInfo);

  const includePatterns = [
    ...defaults.includePatterns,
    ...(manifestConfigInclude ?? [])
  ];
  const excludePatterns = manifestConfigExclude ?? [];

  const baseFilter = createPackageFileFilter({
    include: includePatterns,
    exclude: excludePatterns
  });

  return (relativePath: string): boolean => {
    const normalized = normalizePathForProcessing(relativePath);
    if (!normalized) {
      return false;
    }

    if (defaults.hardIncludeFiles.has(normalized)) {
      return true;
    }

    return baseFilter(relativePath);
  };
}

async function findPackageManifest(packageDir: string): Promise<ManifestInfo | null> {
  for (const relativePath of MANIFEST_RELATIVE_PATHS) {
    const fullPath = join(packageDir, relativePath);
    if (await exists(fullPath)) {
      return { fullPath, relativePath };
    }
  }
  return null;
}

async function buildDefaultIncludeConfig(
  packageDir: string,
  manifestInfo: ManifestInfo | null
): Promise<DefaultIncludeConfig> {
  const includePatterns = new Set<string>();
  const hardIncludeFiles = new Set<string>();

  for (const relPath of MANIFEST_RELATIVE_PATHS) {
    includePatterns.add(relPath);
    hardIncludeFiles.add(normalizePathForProcessing(relPath));
  }

  if (manifestInfo) {
    includePatterns.add(manifestInfo.relativePath);
    hardIncludeFiles.add(normalizePathForProcessing(manifestInfo.relativePath));
  }

  const rootFiles = new Set<string>([FILE_PATTERNS.AGENTS_MD]);
  const universalSubdirs = new Set<string>();

  for (const platform of getAllPlatforms({ includeDisabled: true })) {
    const definition = getPlatformDefinition(platform);
    if (definition.rootFile) {
      rootFiles.add(definition.rootFile);
    }

    for (const subdirKey of Object.keys(definition.subdirs ?? {})) {
      universalSubdirs.add(subdirKey);
    }
  }

  for (const rootFile of rootFiles) {
    includePatterns.add(rootFile);
  }

  await Promise.all(
    Array.from(universalSubdirs).map(async subdirName => {
      const canonicalDir = `${DIR_PATTERNS.OPENPACKAGE}/${subdirName}`;
      const absoluteDir = join(packageDir, canonicalDir);
      if (!(await exists(absoluteDir))) {
        return;
      }

      includePatterns.add(`${canonicalDir}/**`);
    })
  );

  return {
    includePatterns: Array.from(includePatterns),
    hardIncludeFiles
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing package files
// ─────────────────────────────────────────────────────────────────────────────

export interface WritePackageFilesOptions {
  /**
   * When true, preserve the package.index.yml file even if it's not in the
   * incoming file list. Useful when writing to the local cache where the
   * index should persist across updates.
   */
  preserveIndexFile?: boolean;
}

/**
 * Write package files to a directory, syncing its contents.
 *
 * - Creates the target directory if it doesn't exist.
 * - Removes files that are no longer part of the payload (except protected paths).
 * - Writes all incoming files, creating subdirectories as needed.
 *
 * @param targetDir - Absolute path to the destination directory.
 * @param files - Array of PackageFile entries to write.
 * @param options - Optional settings (e.g., preserveIndexFile).
 */
export async function writePackageFilesToDirectory(
  targetDir: string,
  files: PackageFile[],
  options: WritePackageFilesOptions = {}
): Promise<void> {
  await ensureDir(targetDir);

  // Build the set of paths that should remain after the write
  const pathsToKeep = new Set<string>(files.map(f => normalizePathForProcessing(f.path)));

  if (options.preserveIndexFile) {
    pathsToKeep.add(PACKAGE_INDEX_FILENAME);
  }

  // Remove stale files (but never touch protected paths like packages/**)
  await removeStaleFiles(targetDir, pathsToKeep);

  // Write all incoming files in parallel
  await Promise.all(files.map(file => writeFile(targetDir, file)));
}

/**
 * Remove files in targetDir that are not in pathsToKeep and are not protected.
 */
async function removeStaleFiles(targetDir: string, pathsToKeep: Set<string>): Promise<void> {
  if (!(await exists(targetDir))) {
    return;
  }

  for await (const fullPath of walkFiles(targetDir)) {
    const relPath = normalizePathForProcessing(relative(targetDir, fullPath));

    // Skip files we want to keep
    if (pathsToKeep.has(relPath)) {
      continue;
    }

    // Never delete protected paths (e.g., packages/**)
    if (isExcludedFromPackage(relPath)) {
      continue;
    }

    try {
      await remove(fullPath);
      logger.debug(`Removed stale file: ${relPath}`);
    } catch (error) {
      logger.warn(`Failed to remove stale file ${relPath}: ${error}`);
    }
  }
}

/**
 * Write a single PackageFile to disk under targetDir.
 */
async function writeFile(targetDir: string, file: PackageFile): Promise<void> {
  const targetPath = join(targetDir, file.path);
  await ensureDir(dirname(targetPath));
  await writeTextFile(targetPath, file.content, (file.encoding as BufferEncoding) ?? 'utf8');
}



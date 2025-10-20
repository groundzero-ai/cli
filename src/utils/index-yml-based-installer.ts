import { join, relative, dirname } from 'path';
import { listDirectories, listFiles, exists, ensureDir } from './fs.js';
import { logger } from './logger.js';
import { getFormulaVersionPath } from '../core/directory.js';
import { readIndexYml } from '../core/discovery/index-files-discovery.js';
import { writeIfChanged } from '../core/install/file-updater.js';
import { getPlatformDefinition, getDetectedPlatforms, type Platform } from '../core/platforms.js';
import { UNIVERSAL_SUBDIRS } from '../constants/index.js';
import type { InstallOptions } from '../types/index.js';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises';

type UniversalSubdir = typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS];

export interface IndexYmlInstallResult {
  installed: number;
  updated: number;
  skipped: number;
  files: string[];
  installedFiles: string[];
  updatedFiles: string[];
}

type RegistryDirFile = {
  relativePath: string; // relative to the directory containing index.yml
  fullPath: string;     // absolute path in registry
  content: Buffer;
};

/**
 * Recursively find directories in registry that contain an index.yml with matching formula.name
 * Returns paths relative to the formula version root (e.g., "rules/subdir", "commands/tools")
 */
export async function discoverRegistryIndexYmlDirs(
  formulaName: string,
  version: string
): Promise<string[]> {
  const root = getFormulaVersionPath(formulaName, version);

  async function recurse(dir: string, rel: string, acc: string[]): Promise<void> {
    const files = await listFiles(dir);
    if (files.includes('index.yml')) {
      try {
        const marker = await readIndexYml(join(dir, 'index.yml'));
        if (marker && marker.formula?.name === formulaName) {
          acc.push(rel === '' ? '.' : rel);
        }
      } catch (err) {
        logger.warn(`Failed to read index.yml at ${join(dir, 'index.yml')}: ${err}`);
      }
    }

    const subdirs = await listDirectories(dir);
    for (const sub of subdirs) {
      const subdir = join(dir, sub);
      const subrel = rel === '' ? sub : join(rel, sub);
      await recurse(subdir, subrel, acc);
    }
  }

  const matches: string[] = [];
  await recurse(root, '', matches);
  return matches;
}

/**
 * Read an index.yml directory from registry recursively, returning file entries.
 * Skips the index.yml itself from returned list.
 */
export async function readRegistryDirectoryRecursive(
  formulaName: string,
  version: string,
  dirRelToRoot: string
): Promise<RegistryDirFile[]> {
  const base = getFormulaVersionPath(formulaName, version);
  const absBaseDir = join(base, dirRelToRoot);

  async function walk(absDir: string, relToIndexDir: string, acc: RegistryDirFile[]): Promise<void> {
    const files = await listFiles(absDir);
    for (const f of files) {
      const absFile = join(absDir, f);
      const relFile = relToIndexDir === '' ? f : join(relToIndexDir, f);
      const content = await fsReadFile(absFile);
      acc.push({ fullPath: absFile, relativePath: relFile, content });
    }

    const subdirs = await listDirectories(absDir);
    for (const sub of subdirs) {
      const nextAbs = join(absDir, sub);
      const nextRel = relToIndexDir === '' ? sub : join(relToIndexDir, sub);
      await walk(nextAbs, nextRel, acc);
    }
  }

  const results: RegistryDirFile[] = [];
  await walk(absBaseDir, '', results);
  return results;
}

/**
 * Install all files within an index.yml directory to both detected and specified platforms.
 * Preserves directory structure under the corresponding universal subdir path.
 */
export async function installIndexYmlDirectory(
  cwd: string,
  universalSubdir: UniversalSubdir,
  relDirPath: string,
  files: RegistryDirFile[],
  platforms: Platform[],
  options: InstallOptions
): Promise<IndexYmlInstallResult> {
  const result: IndexYmlInstallResult = {
    installed: 0,
    updated: 0,
    skipped: 0,
    files: [],
    installedFiles: [],
    updatedFiles: []
  };

  async function writeIfChangedBinary(absFile: string, content: Buffer): Promise<'created' | 'updated' | 'unchanged'> {
    await ensureDir(dirname(absFile));
    const fileExists = await exists(absFile);
    if (!fileExists) {
      await fsWriteFile(absFile, content);
      return 'created';
    }
    let existing: Buffer | null = null;
    try {
      existing = await fsReadFile(absFile);
    } catch {
      existing = null;
    }
    if (!existing || !content.equals(existing)) {
      await fsWriteFile(absFile, content);
      return 'updated';
    }
    return 'unchanged';
  }

  // Merge detected platforms with specified platforms, keeping order: specified first, then detected
  const detected = await getDetectedPlatforms(cwd);
  const mergedPlatforms: Platform[] = Array.from(new Set([...(platforms || []), ...(detected as Platform[])]));

  for (const platform of mergedPlatforms) {
    const def = getPlatformDefinition(platform);
    const subdirDef = def.subdirs[universalSubdir];
    if (!subdirDef) {
      logger.debug(`Platform ${platform} does not support ${universalSubdir}; skipping`);
      continue;
    }

    for (const file of files) {
      try {
        // Determine target filename:
        // - If index.yml, preserve as-is
        // - If markdown (.md), convert to platform writeExt
        // - Otherwise preserve original extension
        let targetFileName: string;
        const lower = file.relativePath.toLowerCase();
        if (lower.endsWith('.md')) {
          const withoutExt = file.relativePath.replace(/\.[^.]+$/, '');
          targetFileName = withoutExt + subdirDef.writeExt;
        } else {
          targetFileName = file.relativePath;
        }
        const absDir = join(cwd, def.rootDir, subdirDef.path, relDirPath);
        const absFile = join(absDir, targetFileName);

        const outcome = lower.endsWith('index.yml') || lower.endsWith('.md')
          ? await writeIfChanged(absFile, file.content.toString('utf8'))
          : await writeIfChangedBinary(absFile, file.content);
        const relPath = relative(cwd, absFile);
        result.files.push(relPath);
        if (outcome === 'created') {
          result.installed++;
          result.installedFiles.push(relPath);
        } else if (outcome === 'updated') {
          result.updated++;
          result.updatedFiles.push(relPath);
        }
      } catch (error) {
        logger.warn(`Failed to install index.yml file for platform ${platform}: ${error}`);
        result.skipped++;
      }
    }
  }

  return result;
}

/**
 * Orchestrate installation of all index.yml-marked directories from registry
 */
export async function installIndexYmlFiles(
  cwd: string,
  formulaName: string,
  version: string,
  platforms: Platform[],
  options: InstallOptions
): Promise<IndexYmlInstallResult> {
  const allResults: IndexYmlInstallResult = {
    installed: 0,
    updated: 0,
    skipped: 0,
    files: [],
    installedFiles: [],
    updatedFiles: []
  };

  const indexDirs = await discoverRegistryIndexYmlDirs(formulaName, version);
  if (indexDirs.length === 0) {
    return allResults;
  }

  for (const dirRel of indexDirs) {
    // Parse universal subdir and relative dir under it
    const parts = dirRel.split('/');
    const first = parts[0];
    const rest = parts.slice(1).join('/');
    const universalSubdir = (first === '.' ? '' : first) as UniversalSubdir;

    if (!universalSubdir || !Object.values(UNIVERSAL_SUBDIRS).includes(universalSubdir)) {
      // If directory is at root ("."), skip - only universal subdirs are supported for index.yml install
      logger.debug(`Skipping index.yml directory not under a universal subdir: ${dirRel}`);
      continue;
    }

    const files = await readRegistryDirectoryRecursive(formulaName, version, dirRel);
    const perDir = await installIndexYmlDirectory(
      cwd,
      universalSubdir,
      rest,
      files,
      platforms,
      options
    );

    allResults.installed += perDir.installed;
    allResults.updated += perDir.updated;
    allResults.skipped += perDir.skipped;
    allResults.files.push(...perDir.files);
    allResults.installedFiles.push(...perDir.installedFiles);
    allResults.updatedFiles.push(...perDir.updatedFiles);
  }

  return allResults;
}



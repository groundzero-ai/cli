import { join, relative, dirname } from 'path';
import { listDirectories, listFiles, exists, ensureDir, remove } from './fs.js';
import { logger } from './logger.js';
import { getFormulaVersionPath } from '../core/directory.js';
import { readIndexYml } from '../core/discovery/index-files-discovery.js';
import { writeIfChanged } from '../core/install/file-updater.js';
import { getPlatformDefinition, getDetectedPlatforms, type Platform } from '../core/platforms.js';
import { UNIVERSAL_SUBDIRS } from '../constants/index.js';
import type { InstallOptions } from '../types/index.js';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises';
import * as fs from 'fs/promises';
import * as readline from 'readline';

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

export type { RegistryDirFile };

export interface IndexYmlDirectory {
  dirRelToRoot: string;
  registryId: string | null;
  files: RegistryDirFile[];
}

type CwdIndexDirEntry = {
  id: string;
  platform: Platform;
  universalSubdir: UniversalSubdir;
  dirAbsPath: string; // absolute path to dir containing index.yml
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

export async function readRegistryIndexId(
  formulaName: string,
  version: string,
  dirRelToRoot: string
): Promise<string | null> {
  const base = getFormulaVersionPath(formulaName, version);
  const indexPath = join(base, dirRelToRoot, 'index.yml');
  try {
    const marker = await readIndexYml(indexPath);
    const id = marker?.formula?.id as string | undefined;
    return id ?? null;
  } catch (err) {
    logger.warn(`Failed to read registry index.yml at ${indexPath}: ${err}`);
    return null;
  }
}

async function getIndexIdFromCwdDir(dirAbsPath: string): Promise<string | null> {
  const indexPath = join(dirAbsPath, 'index.yml');
  if (!(await exists(indexPath))) return null;
  try {
    const marker = await readIndexYml(indexPath);
    const id = marker?.formula?.id as string | undefined;
    return id ?? null;
  } catch (err) {
    logger.warn(`Failed to parse index.yml at ${indexPath}: ${err}`);
    return null;
  }
}

async function buildCwdIndexYmlIdMap(
  cwd: string,
  platforms: Platform[]
): Promise<Map<string, CwdIndexDirEntry[]>> {
  const map = new Map<string, CwdIndexDirEntry[]>();

  async function recurseDirs(baseDir: string, platform: Platform, universalSubdir: UniversalSubdir): Promise<void> {
    // If index.yml exists here, record it
    const files = await listFiles(baseDir).catch(() => [] as string[]);
    if (files.includes('index.yml')) {
      const id = await getIndexIdFromCwdDir(baseDir);
      if (id) {
        const entry: CwdIndexDirEntry = { id, platform, universalSubdir, dirAbsPath: baseDir };
        if (!map.has(id)) map.set(id, []);
        map.get(id)!.push(entry);
      }
    }
    // Recurse subdirectories
    const subdirs = await listDirectories(baseDir).catch(() => [] as string[]);
    for (const sub of subdirs) {
      await recurseDirs(join(baseDir, sub), platform, universalSubdir);
    }
  }

  for (const platform of platforms) {
    const def = getPlatformDefinition(platform);
    for (const universalSubdir of Object.values(UNIVERSAL_SUBDIRS)) {
      const subdirDef = def.subdirs[universalSubdir];
      if (!subdirDef) continue;
      const root = join(cwd, def.rootDir, subdirDef.path);
      if (await exists(root)) {
        await recurseDirs(root, platform, universalSubdir);
      }
    }
  }

  return map;
}

async function clearDirectory(dirAbsPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirAbsPath, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const full = join(dirAbsPath, entry.name);
      await remove(full);
    }));
  } catch (err) {
    // If directory doesn't exist, nothing to clear
    return;
  }
}

async function promptUserForOverwrite(promptText: string): Promise<boolean> {
  // If not an interactive TTY, default to skip
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    logger.warn(`${promptText} [non-interactive: skipping]`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${promptText} (y/N) `, (answer) => {
      rl.close();
      const normalized = (answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}

async function writeFilesForSinglePlatform(
  cwd: string,
  universalSubdir: UniversalSubdir,
  targetRelDir: string,
  files: RegistryDirFile[],
  platform: Platform,
  options: InstallOptions,
  result: IndexYmlInstallResult
): Promise<void> {
  const def = getPlatformDefinition(platform);
  const subdirDef = def.subdirs[universalSubdir];
  if (!subdirDef) {
    logger.debug(`Platform ${platform} does not support ${universalSubdir}; skipping`);
    return;
  }

  // Write all files preserving directory layout; convert .md extension to platform writeExt
  for (const file of files) {
    try {
      let targetFileName: string;
      const lower = file.relativePath.toLowerCase();
      if (lower.endsWith('.md')) {
        const withoutExt = file.relativePath.replace(/\.[^.]+$/, '');
        targetFileName = withoutExt + subdirDef.writeExt;
      } else {
        targetFileName = file.relativePath;
      }
      const absDir = join(cwd, def.rootDir, subdirDef.path, targetRelDir);
      const absFile = join(absDir, targetFileName);

      const outcome = lower.endsWith('index.yml') || lower.endsWith('.md')
        ? await writeIfChanged(absFile, file.content.toString('utf8'))
        : await (async () => {
            await ensureDir(dirname(absFile));
            const fileExists = await exists(absFile);
            if (!fileExists) {
              await fsWriteFile(absFile, file.content);
              return 'created' as const;
            }
            let existing: Buffer | null = null;
            try {
              existing = await fsReadFile(absFile);
            } catch {
              existing = null;
            }
            if (!existing || !file.content.equals(existing)) {
              await fsWriteFile(absFile, file.content);
              return 'updated' as const;
            }
            return 'unchanged' as const;
          })();

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

/**
 * Install all files within an index.yml directory to both detected and specified platforms.
 * Preserves directory structure under the corresponding universal subdir path.
 */
async function installIndexYmlDirectory(
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
 * Install pre-discovered index.yml directories (no discovery step here)
 */
export async function installIndexYmlDirectories(
  cwd: string,
  directories: IndexYmlDirectory[],
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

  // Determine platforms to consider (specified first, then detected uniques)
  const detected = await getDetectedPlatforms(cwd);
  const mergedPlatforms: Platform[] = Array.from(new Set([...(platforms || []), ...(detected as Platform[])]));

  // Build CWD ID map once
  const cwdIdMap = await buildCwdIndexYmlIdMap(cwd, mergedPlatforms);

  // Track processed registry dir prefixes per platform to avoid double-processing children
  const processedByPlatform = new Map<Platform, Set<string>>();
  function getProcessedSet(platform: Platform): Set<string> {
    let set = processedByPlatform.get(platform);
    if (!set) {
      set = new Set<string>();
      processedByPlatform.set(platform, set);
    }
    return set;
  }
  function isCovered(platform: Platform, dirRel: string): boolean {
    const set = processedByPlatform.get(platform);
    if (!set) return false;
    for (const prefix of set) {
      if (dirRel === prefix || dirRel.startsWith(prefix + '/')) return true;
    }
    return false;
  }
  function markProcessed(platform: Platform, dirRel: string): void {
    getProcessedSet(platform).add(dirRel);
  }

  for (const entry of directories) {
    const dirRel = entry.dirRelToRoot;
    const registryId = entry.registryId;
    const parts = dirRel.split('/');
    const first = parts[0];
    const rest = parts.slice(1).join('/');
    const universalSubdir = (first === '.' ? '' : first) as UniversalSubdir;

    if (!universalSubdir || !Object.values(UNIVERSAL_SUBDIRS).includes(universalSubdir)) {
      logger.debug(`Skipping index.yml directory not under a universal subdir: ${dirRel}`);
      continue;
    }

    if (registryId) {
      // Try ID-based matching per platform first
      for (const platform of mergedPlatforms) {
        if (isCovered(platform, dirRel)) continue;
        const def = getPlatformDefinition(platform);
        const subdirDef = def.subdirs[universalSubdir];
        if (!subdirDef) continue;

        const entries = cwdIdMap.get(registryId)?.filter(e => e.platform === platform && e.universalSubdir === universalSubdir) || [];
        if (entries.length > 0) {
          const entryMatch = entries[0];
          const baseDir = join(cwd, def.rootDir, subdirDef.path);
          const targetRel = relative(baseDir, entryMatch.dirAbsPath);

          if (!options.dryRun) {
            await clearDirectory(entryMatch.dirAbsPath);
          }
          await writeFilesForSinglePlatform(cwd, universalSubdir, targetRel, entry.files, platform, options, allResults);
          markProcessed(platform, dirRel);
          continue;
        }

        // No ID match -> path-based overwrite prompt
        const targetBaseDir = join(cwd, def.rootDir, subdirDef.path, rest);
        const targetExists = await exists(targetBaseDir);
        let proceed = true;
        if (targetExists) {
          const targetId = await getIndexIdFromCwdDir(targetBaseDir);
          if (!targetId || targetId !== registryId) {
            if (options.force) {
              proceed = true;
            } else {
              const rel = relative(cwd, targetBaseDir);
              proceed = await promptUserForOverwrite(`Directory ${rel} exists with no or different index.yml id. Overwrite`);
            }
          }
        }
        if (!proceed) continue;
        if (!options.dryRun && targetExists) {
          await clearDirectory(targetBaseDir);
        }
        await writeFilesForSinglePlatform(cwd, universalSubdir, rest, entry.files, platform, options, allResults);
        markProcessed(platform, dirRel);
      }
      continue;
    }

    // No registry ID present -> pure path-based install for all platforms
    for (const platform of mergedPlatforms) {
      if (isCovered(platform, dirRel)) continue;
      const def = getPlatformDefinition(platform);
      const subdirDef = def.subdirs[universalSubdir];
      if (!subdirDef) continue;
      const targetBaseDir = join(cwd, def.rootDir, subdirDef.path, rest);
      const targetExists = await exists(targetBaseDir);
      let proceed = true;
      if (targetExists) {
        const targetId = await getIndexIdFromCwdDir(targetBaseDir);
        if (!targetId) {
          if (options.force) {
            proceed = true;
          } else {
            const rel = relative(cwd, targetBaseDir);
            proceed = await promptUserForOverwrite(`Directory ${rel} exists without index.yml. Overwrite`);
          }
        }
      }
      if (!proceed) continue;
      if (!options.dryRun && targetExists) {
        await clearDirectory(targetBaseDir);
      }
      await writeFilesForSinglePlatform(cwd, universalSubdir, rest, entry.files, platform, options, allResults);
      markProcessed(platform, dirRel);
    }
  }

  return allResults;
}



import { join, relative, dirname } from 'path';
import { isJunk } from 'junk';
import { listDirectories, listFiles, exists, ensureDir, remove } from './fs.js';
import { logger } from './logger.js';
import { getFormulaVersionPath } from '../core/directory.js';
import { readIndexYml } from '../core/discovery/index-files-discovery.js';
import { writeIfChanged } from '../core/install/file-updater.js';
import { getPlatformDefinition, getDetectedPlatforms, type Platform } from '../core/platforms.js';
import { FILE_PATTERNS, UNIVERSAL_SUBDIRS, PLATFORM_DIRS } from '../constants/index.js';
import type { InstallOptions } from '../types/index.js';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises';
import * as fs from 'fs/promises';
import * as readline from 'readline';
import { areFormulaNamesEquivalent } from './formula-name.js';

type UniversalSubdir = typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS];

type WriteOutcome = 'created' | 'updated' | 'unchanged';

async function writeIfChangedBinary(absFile: string, content: Buffer): Promise<WriteOutcome> {
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

function splitDirRel(dirRel: string): { first: string; rest: string; isAi: boolean; universalSubdir: UniversalSubdir | null } {
  const parts = dirRel.split('/');
  const first = parts[0];
  const rest = parts.slice(1).join('/');
  const isAi = first === PLATFORM_DIRS.AI;
  const universalSubdir = isAi ? null : (first === '.' ? '' : first) as UniversalSubdir;
  return { first, rest, isAi, universalSubdir };
}

function computeTargetFileName(relPath: string, writeExt?: string): string {
  const lower = relPath.toLowerCase();
  if (writeExt && lower.endsWith(FILE_PATTERNS.MD_FILES)) {
    const withoutExt = relPath.replace(/\.[^.]+$/, '');
    return withoutExt + writeExt;
  }
  return relPath;
}

function isTextLike(pathLower: string): boolean {
  return pathLower.endsWith(FILE_PATTERNS.INDEX_YML) || pathLower.endsWith(FILE_PATTERNS.MD_FILES);
}

function recordResult(result: IndexYmlInstallResult, relPath: string, outcome: WriteOutcome): void {
  result.files.push(relPath);
  if (outcome === 'created') {
    result.installed++;
    result.installedFiles.push(relPath);
  } else if (outcome === 'updated') {
    result.updated++;
    result.updatedFiles.push(relPath);
  }
}

async function writeFilesToTarget(
  cwd: string,
  baseDir: string,
  targetRelDir: string,
  files: RegistryDirFile[],
  writeExt: string | undefined,
  result: IndexYmlInstallResult
): Promise<void> {
  for (const file of files) {
    try {
      const targetFileName = computeTargetFileName(file.relativePath, writeExt);
      const absDir = join(baseDir, targetRelDir);
      const absFile = join(absDir, targetFileName);
      await ensureDir(dirname(absFile));

      const isText = isTextLike(targetFileName.toLowerCase());
      const outcome = isText
        ? await writeIfChanged(absFile, file.content.toString('utf8'))
        : await writeIfChangedBinary(absFile, file.content);

      const relPath = relative(cwd, absFile);
      recordResult(result, relPath, outcome);
    } catch (error) {
      logger.warn(`Failed to install file ${file.relativePath}: ${error}`);
      result.skipped++;
    }
  }
}

function createPrefixTracker<K>(): {
  isCovered: (key: K, dirRel: string) => boolean;
  mark: (key: K, dirRel: string) => void;
} {
  const map = new Map<K, Set<string>>();
  const get = (k: K) => {
    let s = map.get(k);
    if (!s) {
      s = new Set<string>();
      map.set(k, s);
    }
    return s;
  };
  return {
    isCovered(key, dirRel) {
      const set = map.get(key);
      if (!set) return false;
      for (const prefix of set) {
        if (dirRel === prefix || dirRel.startsWith(prefix + '/')) return true;
      }
      return false;
    },
    mark(key, dirRel) {
      get(key).add(dirRel);
    }
  };
}

async function shouldProceedWithOverwrite(
  targetBaseDir: string,
  expectedId: string | null,
  options: InstallOptions
): Promise<boolean> {
  const targetExists = await exists(targetBaseDir);
  if (!targetExists) return true;

  const targetId = await getIndexIdFromCwdDir(targetBaseDir);

  // Same ID → safe overwrite
  if (expectedId && targetId === expectedId) return true;

  // Forced
  if (options.force) return true;

  // Non-interactive defaults to skip (retain current behavior)
  const relPromptBase = relative(process.cwd(), targetBaseDir) || targetBaseDir;
  if (!targetId && !expectedId) {
    return await promptUserForOverwrite(`Directory ${relPromptBase} exists without index.yml. Overwrite`);
  }
  return await promptUserForOverwrite(`Directory ${relPromptBase} exists with no or different index.yml id. Overwrite`);
}

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
    if (files.includes(FILE_PATTERNS.INDEX_YML)) {
      try {
        const marker = await readIndexYml(join(dir, FILE_PATTERNS.INDEX_YML));
        if (marker && marker.formula?.name && areFormulaNamesEquivalent(marker.formula.name, formulaName)) {
          acc.push(rel === '' ? '.' : rel);
        }
      } catch (err) {
        logger.warn(`Failed to read index.yml at ${join(dir, FILE_PATTERNS.INDEX_YML)}: ${err}`);
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
  const indexPath = join(base, dirRelToRoot, FILE_PATTERNS.INDEX_YML);
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
  const indexPath = join(dirAbsPath, FILE_PATTERNS.INDEX_YML);
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
    if (files.includes(FILE_PATTERNS.INDEX_YML)) {
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

async function buildCwdAiIndexYmlIdMap(
  cwd: string
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();

  async function recurse(baseDir: string): Promise<void> {
    const files = await listFiles(baseDir).catch(() => [] as string[]);
    if (files.includes(FILE_PATTERNS.INDEX_YML)) {
      const id = await getIndexIdFromCwdDir(baseDir);
      if (id) {
        if (!map.has(id)) map.set(id, []);
        map.get(id)!.push(baseDir);
      }
    }
    const subdirs = await listDirectories(baseDir).catch(() => [] as string[]);
    for (const sub of subdirs) {
      await recurse(join(baseDir, sub));
    }
  }

  const aiRoot = join(cwd, PLATFORM_DIRS.AI);
  if (await exists(aiRoot)) {
    await recurse(aiRoot);
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

  const detected = await getDetectedPlatforms(cwd);
  const mergedPlatforms: Platform[] = Array.from(new Set([...(platforms || []), ...(detected as Platform[])]));

  const cwdIdMap = await buildCwdIndexYmlIdMap(cwd, mergedPlatforms);
  const cwdAiIdMap = await buildCwdAiIndexYmlIdMap(cwd);

  const aiTracker = createPrefixTracker<'AI'>();
  const platformTracker = createPrefixTracker<Platform>();

  for (const entry of directories) {
    const { isAi, universalSubdir, rest } = splitDirRel(entry.dirRelToRoot);
    const registryId = entry.registryId;

    if (isAi) {
      if (aiTracker.isCovered('AI', entry.dirRelToRoot)) continue;
      const aiRoot = join(cwd, PLATFORM_DIRS.AI);

      let targetAbs: string | null = null;
      if (registryId) {
        const matches = cwdAiIdMap.get(registryId) || [];
        if (matches.length > 0) {
          targetAbs = matches[0]; // id-based
        }
      }
      if (!targetAbs) targetAbs = join(aiRoot, rest);

      const proceed = await shouldProceedWithOverwrite(targetAbs, registryId, options);
      if (!proceed) continue;

      if (!options.dryRun && await exists(targetAbs)) {
        await clearDirectory(targetAbs);
      }

      const targetRel = relative(aiRoot, targetAbs);
      await writeFilesToTarget(cwd, aiRoot, targetRel, entry.files, undefined, allResults);
      aiTracker.mark('AI', entry.dirRelToRoot);
      continue;
    }

    // Non-AI: universal subdir
    if (!universalSubdir || !Object.values(UNIVERSAL_SUBDIRS).includes(universalSubdir)) {
      logger.debug(`Skipping index.yml directory not under a universal subdir: ${entry.dirRelToRoot}`);
      continue;
    }

    for (const platform of mergedPlatforms) {
      if (platformTracker.isCovered(platform, entry.dirRelToRoot)) continue;

      const def = getPlatformDefinition(platform);
      const subdirDef = def.subdirs[universalSubdir];
      if (!subdirDef) continue;

      const baseDir = join(cwd, def.rootDir, subdirDef.path);

      let targetAbs: string | null = null;
      if (registryId) {
        const matches = (cwdIdMap.get(registryId) || []).filter(e => e.platform === platform && e.universalSubdir === universalSubdir);
        if (matches.length > 0) {
          targetAbs = matches[0].dirAbsPath; // id-based
        }
      }
      if (!targetAbs) targetAbs = join(baseDir, rest);

      const proceed = await shouldProceedWithOverwrite(targetAbs, registryId, options);
      if (!proceed) continue;

      if (!options.dryRun && await exists(targetAbs)) {
        await clearDirectory(targetAbs);
      }

      const targetRel = relative(baseDir, targetAbs);
      await writeFilesToTarget(cwd, baseDir, targetRel, entry.files, subdirDef.writeExt, allResults);
      platformTracker.mark(platform, entry.dirRelToRoot);
    }
  }

  return allResults;
}



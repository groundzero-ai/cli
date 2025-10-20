import { join } from 'path';
import * as yaml from 'js-yaml';
import { exists, isDirectory, listDirectories, listFiles, readTextFile } from '../../utils/fs.js';
import { calculateFileHash } from '../../utils/hash-utils.js';
import { getFileMtime, Platformish } from '../../utils/discovery/file-processing.js';
import type { DiscoveredFile } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import type { FormulaMarkerYml } from '../../utils/md-frontmatter.js';
import { obtainSourceDirAndRegistryPath } from './file-discovery.js';
import { FILE_PATTERNS } from '../../constants/index.js';

export async function readIndexYml(path: string): Promise<FormulaMarkerYml | null> {
  try {
    const content = await readTextFile(path);
    const parsed = yaml.load(content) as any;
    return parsed || null;
  } catch (error) {
    logger.warn(`Failed to parse index.yml at ${path}: ${error}`);
    return null;
  }
}

async function recursivelyListAllFiles(dir: string, baseDir: string): Promise<Array<{ fullPath: string; relativePath: string }>> {
  const results: Array<{ fullPath: string; relativePath: string }> = [];
  if (!(await exists(dir)) || !(await isDirectory(dir))) return results;

  const files = await listFiles(dir);
  for (const f of files) {
    const fullPath = join(dir, f);
    results.push({ fullPath, relativePath: fullPath.substring(baseDir.length + 1) });
  }

  const subdirs = await listDirectories(dir);
  for (const sub of subdirs) {
    const subdir = join(dir, sub);
    const subfiles = await recursivelyListAllFiles(subdir, baseDir);
    results.push(...subfiles);
  }

  return results;
}

async function findMatchingIndexYmlDirsRecursive(rootDir: string, formulaName: string): Promise<string[]> {
  const matches: string[] = [];
  if (!(await exists(rootDir)) || !(await isDirectory(rootDir))) return matches;

  const indexPath = join(rootDir, FILE_PATTERNS.INDEX_YML);
  if (await exists(indexPath)) {
    const content = await readIndexYml(indexPath);
    if (content && content.formula?.name === formulaName) {
      matches.push(rootDir);
    }
  }

  const subdirs = await listDirectories(rootDir);
  for (const sub of subdirs) {
    const subdir = join(rootDir, sub);
    const subMatches = await findMatchingIndexYmlDirsRecursive(subdir, formulaName);
    if (subMatches.length > 0) matches.push(...subMatches);
  }
  return matches;
}

export async function discoverIndexYmlMarkedFiles(
  rootDir: string,
  formulaName: string,
  platform: Platformish,
  registryPathPrefix: string
): Promise<DiscoveredFile[]> {

  const candidateDirs = await findMatchingIndexYmlDirsRecursive(rootDir, formulaName);
  if (candidateDirs.length === 0) return [];

  const dedupByFullPath = new Map<string, DiscoveredFile>();

  for (const dir of candidateDirs) {
    const files = await recursivelyListAllFiles(dir, dir);
    for (const f of files) {
      try {
        const content = await readTextFile(f.fullPath);
        const mtime = await getFileMtime(f.fullPath);
        const contentHash = await calculateFileHash(content);
        const { sourceDir, registryPath } = await obtainSourceDirAndRegistryPath(f, platform, registryPathPrefix);

        const discovered: DiscoveredFile = {
          fullPath: f.fullPath,
          relativePath: f.relativePath,
          sourceDir,
          registryPath,
          mtime,
          contentHash,
          discoveredViaIndexYml: true
        };
        if (!dedupByFullPath.has(f.fullPath)) {
          dedupByFullPath.set(f.fullPath, discovered);
        }
      } catch (err) {
        logger.warn(`Failed to process file for index.yml discovery ${f.fullPath}: ${err}`);
      }
    }
  }
  return Array.from(dedupByFullPath.values());
}


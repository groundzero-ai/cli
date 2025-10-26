import { join } from 'path';
import { formulaManager } from '../core/formula.js';
import { isValidEntityId } from './entity-id.js';
import { UNIVERSAL_SUBDIRS, FILE_PATTERNS, type Platform } from '../constants/index.js';
import type { FormulaFile } from '../types/index.js';
import {
  buildRegistryIdMap,
  type RegistryFileInfo
} from './id-based-discovery.js';
import {
  discoverRegistryIndexYmlDirs,
  readRegistryDirectoryRecursive,
  readRegistryIndexId,
} from './index-yml-based-installer.js';
import { getPlatformDefinition } from '../core/platforms.js';

export type { RegistryFileInfo };

export type RegistryDirFile = {
  relativePath: string;
  fullPath: string;
  content: Buffer;
};

export interface IndexYmlDirectory {
  dirRelToRoot: string; // e.g., "rules/subdir"
  registryId: string | null;
  files: RegistryDirFile[];
}

export interface CategorizedInstallFiles {
  idBasedFiles: Map<string, RegistryFileInfo>;
  indexYmlDirs: IndexYmlDirectory[];
  pathBasedFiles: FormulaFile[];
  rootFiles: Map<string, string>;
}

function isInIndexYmlDir(path: string, indexDirs: string[]): boolean {
  for (const dirRel of indexDirs) {
    if (path === dirRel || path.startsWith(dirRel + '/')) return true;
  }
  return false;
}

function collectRootFiles(
  formulaFiles: FormulaFile[],
  platforms: Platform[]
): Map<string, string> {
  const rootFiles = new Map<string, string>();
  // Always consider universal AGENTS.md if present
  const agents = formulaFiles.find(f => f.path === FILE_PATTERNS.AGENTS_MD);
  if (agents) rootFiles.set(FILE_PATTERNS.AGENTS_MD, agents.content);

  // Platform-specific root files
  const platformRootNames = new Set<string>();
  for (const platform of platforms) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) platformRootNames.add(def.rootFile);
  }
  for (const file of formulaFiles) {
    if (platformRootNames.has(file.path)) {
      rootFiles.set(file.path, file.content);
    }
  }
  return rootFiles;
}

export async function discoverAndCategorizeFiles(
  formulaName: string,
  version: string,
  platforms: Platform[]
): Promise<CategorizedInstallFiles> {
  // Load once
  const formula = await formulaManager.loadFormula(formulaName, version);

  // Priority 1: ID-based registry map (platform markdown files with valid IDs)
  const registryIdMap = await buildRegistryIdMap(formulaName, version);
  const idBasedFiles = new Map<string, RegistryFileInfo>();
  const idBasedPaths = new Set<string>();
  for (const [path, info] of registryIdMap.entries()) {
    if (info.id && isValidEntityId(info.id)) {
      idBasedFiles.set(path, info);
      idBasedPaths.add(path);
    }
  }

  // Priority 2: Index.yml directories (filter out any files already claimed by ID-based)
  const indexYmlDirs: IndexYmlDirectory[] = [];
  const discoveredDirs = (await discoverRegistryIndexYmlDirs(formulaName, version))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  for (const dirRel of discoveredDirs) {
    const registryFiles = await readRegistryDirectoryRecursive(formulaName, version, dirRel);
    const filteredFiles = registryFiles.filter(f => {
      const fullRel = dirRel === '.' ? f.relativePath : join(dirRel, f.relativePath);
      return !idBasedPaths.has(fullRel);
    });
    if (filteredFiles.length === 0) continue;
    const registryId = await readRegistryIndexId(formulaName, version, dirRel);
    indexYmlDirs.push({ dirRelToRoot: dirRel, registryId, files: filteredFiles });
  }

  // Priority 3: Remaining path-based files (all not claimed by above)
  const pathBasedFiles: FormulaFile[] = [];
  // Build a quick set of all paths covered by index.yml directories
  const coveredByIndex = new Set<string>();
  for (const dirRel of discoveredDirs) {
    coveredByIndex.add(dirRel);
  }
  for (const file of formula.files) {
    const p = file.path;
    if (p === 'formula.yml') continue; // never install registry formula.yml
    if (idBasedPaths.has(p)) continue; // handled by ID-based
    if (isInIndexYmlDir(p, discoveredDirs)) continue; // handled by index.yml
    // Root files handled separately
    pathBasedFiles.push(file);
  }

  // Priority 4: Root files (platform root + AGENTS.md)
  const rootFiles = collectRootFiles(formula.files, platforms);

  return { idBasedFiles, indexYmlDirs, pathBasedFiles, rootFiles };
}



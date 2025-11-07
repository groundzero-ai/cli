import { join } from 'path';
import { formulaManager } from '../core/formula.js';
import { FILE_PATTERNS, type Platform } from '../constants/index.js';
import type { FormulaFile } from '../types/index.js';
import { getPlatformDefinition } from '../core/platforms.js';

export interface CategorizedInstallFiles {
  pathBasedFiles: FormulaFile[];
  rootFiles: Map<string, string>;
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

  // Priority 1: Path-based files (all files from formula)
  const pathBasedFiles: FormulaFile[] = [];
  for (const file of formula.files) {
    const p = file.path;
    if (p === 'formula.yml') continue; // never install registry formula.yml
    // Root files handled separately
    pathBasedFiles.push(file);
  }

  // Priority 2: Root files (platform root + AGENTS.md)
  const rootFiles = collectRootFiles(formula.files, platforms);

  return { pathBasedFiles, rootFiles };
}



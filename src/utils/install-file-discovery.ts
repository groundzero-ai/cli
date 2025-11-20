import { packageManager } from '../core/package.js';
import { FILE_PATTERNS, type Platform } from '../constants/index.js';
import type { PackageFile } from '../types/index.js';
import { getPlatformDefinition } from '../core/platforms.js';

export interface CategorizedInstallFiles {
  pathBasedFiles: PackageFile[];
  rootFiles: Map<string, string>;
}


function collectRootFiles(
  packageFiles: PackageFile[],
  platforms: Platform[]
): Map<string, string> {
  const rootFiles = new Map<string, string>();
  // Always consider universal AGENTS.md if present
  const agents = packageFiles.find(f => f.path === FILE_PATTERNS.AGENTS_MD);
  if (agents) rootFiles.set(FILE_PATTERNS.AGENTS_MD, agents.content);

  // Platform-specific root files
  const platformRootNames = new Set<string>();
  for (const platform of platforms) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) platformRootNames.add(def.rootFile);
  }
  for (const file of packageFiles) {
    if (platformRootNames.has(file.path)) {
      rootFiles.set(file.path, file.content);
    }
  }
  return rootFiles;
}

export async function discoverAndCategorizeFiles(
  packageName: string,
  version: string,
  platforms: Platform[]
): Promise<CategorizedInstallFiles> {
  // Load once
  const pkg = await packageManager.loadPackage(packageName, version);

  // Priority 1: Path-based files (all files from package)
  const pathBasedFiles: PackageFile[] = [];
  for (const file of pkg.files) {
    const p = file.path;
    if (p === 'package.yml') continue; // never install registry package.yml
    // Root files handled separately
    pathBasedFiles.push(file);
  }

  // Priority 2: Root files (platform root + AGENTS.md)
  const rootFiles = collectRootFiles(pkg.files, platforms);

  return { pathBasedFiles, rootFiles };
}



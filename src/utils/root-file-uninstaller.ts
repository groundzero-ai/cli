/**
 * Root File Uninstaller
 * Utilities to remove package-marked sections from root files and delete empty files
 */

import { join } from 'path';
import { exists, readTextFile, writeTextFile } from './fs.js';
import { logger } from './logger.js';
import { getAllPlatforms, getPlatformDefinition } from '../core/platforms.js';
import { buildOpenMarkerRegex, CLOSE_MARKER_REGEX } from './root-file-extractor.js';

/** Remove a single formula section from root-file content using markers */
function stripPackageSection(content: string, formulaName: string): { changed: boolean; content: string } {
  if (!content) return { changed: false, content };
  const openRe = buildOpenMarkerRegex(formulaName);
  const closeRe = CLOSE_MARKER_REGEX;
  const openMatch = openRe.exec(content);
  if (!openMatch) return { changed: false, content };
  const before = content.slice(0, openMatch.index);
  const rest = content.slice(openMatch.index + openMatch[0].length);
  const closeMatch = closeRe.exec(rest);
  if (!closeMatch) return { changed: false, content };
  const after = rest.slice(closeMatch.index + closeMatch[0].length);
  return { changed: true, content: before + after };
}

/** Remove multiple formula sections from content */
function stripMultiplePackageSections(content: string, formulaNames: string[]): { changed: boolean; content: string } {
  let changed = false;
  let current = content;
  for (const name of formulaNames) {
    const result = stripPackageSection(current, name);
    if (result.changed) changed = true;
    current = result.content;
  }
  return { changed, content: current };
}

/** Discover platform root filenames from platform definitions */
function getUniqueRootFilenames(): string[] {
  const set = new Set<string>();
  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) set.add(def.rootFile);
  }
  return Array.from(set);
}

/**
 * Compute which root files would be updated after stripping sections
 */
export async function computeRootFileRemovalPlan(cwd: string, formulaNames: string[]): Promise<{ toUpdate: string[] }> {
  const toUpdate: string[] = [];
  const rootFiles = getUniqueRootFilenames();
  for (const filename of rootFiles) {
    const absPath = join(cwd, filename);
    if (!(await exists(absPath))) continue;
    const original = await readTextFile(absPath);
    const { changed, content } = stripMultiplePackageSections(original, formulaNames);
    if (!changed) continue;
    // Always update root files, never delete them (even if empty)
    toUpdate.push(filename);
  }
  return { toUpdate };
}

/**
 * Apply root-file updates for provided formulas
 */
export async function applyRootFileRemovals(cwd: string, formulaNames: string[]): Promise<{ updated: string[] }> {
  const updated: string[] = [];
  const rootFiles = getUniqueRootFilenames();
  for (const filename of rootFiles) {
    const absPath = join(cwd, filename);
    if (!(await exists(absPath))) continue;
    const original = await readTextFile(absPath);
    const { changed, content } = stripMultiplePackageSections(original, formulaNames);
    if (!changed) continue;
    // Always update root files, never delete them (even if empty)
    await writeTextFile(absPath, content);
    updated.push(filename);
    logger.debug(`Updated root file: ${absPath}`);
  }
  return { updated };
}



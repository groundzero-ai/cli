import { join } from 'path';
import { PLATFORM_DIRS } from '../../constants/index.js';
import { type UninstallDiscoveredFile } from '../../types/index.js';
import { getAllPlatforms, getPlatformDefinition } from '../platforms.js';
import { exists, isDirectory, walkFiles, readTextFile } from '../../utils/fs.js';
import { extractFormulaContentFromRootFile } from '../../utils/root-file-extractor.js';
import { readFormulaIndex, type FormulaIndexRecord, isDirKey } from '../../utils/formula-index-yml.js';
import { normalizePathForProcessing } from '../../utils/path-normalization.js';

async function collectFilesUnderDirectory(cwd: string, dirRel: string): Promise<string[]> {
  const rel = normalizePathForProcessing(dirRel.endsWith('/') ? dirRel : `${dirRel}/`);
  const absDir = join(cwd, rel);
  if (!(await exists(absDir)) || !(await isDirectory(absDir))) return [];
  const collected: string[] = [];
  for await (const absFile of walkFiles(absDir)) {
    const relPath = normalizePathForProcessing(absFile.slice(cwd.length + 1).replace(/\\/g, '/'));
    collected.push(relPath);
  }
  return collected;
}

async function expandIndexToFilePaths(
  cwd: string,
  index: FormulaIndexRecord | null
): Promise<Set<string>> {
  const owned = new Set<string>();
  if (!index) return owned;

  for (const [key, values] of Object.entries(index.files)) {
    if (isDirKey(key)) {
      for (const dirRel of values) {
        const files = await collectFilesUnderDirectory(cwd, dirRel);
        for (const rel of files) {
          owned.add(normalizePathForProcessing(rel));
        }
      }
    } else {
      for (const value of values) {
        owned.add(normalizePathForProcessing(value));
      }
    }
  }
  return owned;
}

function deriveSourceDir(relPath: string): string {
  const first = normalizePathForProcessing(relPath).split('/')[0] || '';
  return first || PLATFORM_DIRS.AI; // default to 'ai' if uncertain
}

async function discoverViaIndex(
  formulaName: string
): Promise<UninstallDiscoveredFile[]> {
  const cwd = process.cwd();
  const index = await readFormulaIndex(cwd, formulaName);
  const owned = await expandIndexToFilePaths(cwd, index);
  const results: UninstallDiscoveredFile[] = [];

  for (const rel of owned) {
    const fullPath = join(cwd, rel);
    if (await exists(fullPath)) {
      results.push({
        fullPath,
        sourceDir: deriveSourceDir(rel)
      });
    }
  }
  return results;
}

async function discoverLightweightRootFiles(cwd: string, formulaName: string): Promise<UninstallDiscoveredFile[]> {
  // Collect unique root files from platform definitions
  const seen = new Set<string>();
  const results: UninstallDiscoveredFile[] = [];

  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (!def.rootFile) continue;
    const absPath = join(cwd, def.rootFile);
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    if (!(await exists(absPath))) continue;
    try {
      const content = await readTextFile(absPath);
      const extracted = extractFormulaContentFromRootFile(content, formulaName);
      if (!extracted) continue;
      results.push({ fullPath: absPath, sourceDir: platform, isRootFile: true });
    } catch {
      // Ignore errors for uninstall discovery
    }
  }

  return results;
}

export async function discoverFormulaFilesForUninstall(formulaName: string): Promise<UninstallDiscoveredFile[]> {
  const cwd = process.cwd();
  const results: UninstallDiscoveredFile[] = [];

  // Index-based discovery (exact ownership from installation)
  const indexFiles = await discoverViaIndex(formulaName);
  results.push(...indexFiles);

  // Root files are updated (not deleted) — still detect them for reporting
  const rootFiles = await discoverLightweightRootFiles(cwd, formulaName);
  results.push(...rootFiles);

  // Dedupe by fullPath
  const map = new Map<string, UninstallDiscoveredFile>();
  for (const f of results) {
    if (!map.has(f.fullPath)) map.set(f.fullPath, f);
  }
  return Array.from(map.values());
}



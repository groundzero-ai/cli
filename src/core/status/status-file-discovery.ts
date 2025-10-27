import { join, dirname } from 'path';
import { FILE_PATTERNS, PLATFORM_AI, PLATFORM_DIRS, UNIVERSAL_SUBDIRS } from '../../constants/index.js';
import { buildPlatformSearchConfig } from '../discovery/platform-discovery.js';
import { getPlatformDefinition, getAllPlatforms } from '../platforms.js';
import { exists, walkFiles, readTextFile } from '../../utils/fs.js';
import { parseMarkdownFrontmatter } from '../../utils/md-frontmatter.js';
import { findMatchingIndexYmlDirsRecursive } from '../discovery/index-files-discovery.js';
import { extractFormulaContentFromRootFile } from '../../utils/root-file-extractor.js';

/**
 * Discover installed formulas using same methods as uninstall but optimized for status command
 * Returns detailed file information for formulas in the config
 */
export async function discoverFormulasForStatus(
  formulaNames: string[]
): Promise<Map<string, {
  aiFiles: string[];
  platforms: Record<string, {
    rules?: { found: number };
    commands?: { found: number };
    agents?: { found: number }
  }>;
  rootFiles?: string[];
  anyPath?: string
}>> {
  const cwd = process.cwd();
  const result = new Map<string, {
    aiFiles: string[];
    platforms: Record<string, {
      rules?: { found: number };
      commands?: { found: number };
      agents?: { found: number }
    }>;
    rootFiles?: string[];
    anyPath?: string
  }>();

  // Initialize result entries for all requested formulas
  for (const formulaName of formulaNames) {
    result.set(formulaName, { aiFiles: [], platforms: {}, rootFiles: [] });
  }

  // Use same platform detection as uninstall
  const configs = await buildPlatformSearchConfig(cwd);

  // Process each platform configuration
  for (const cfg of configs) {
    if (cfg.platform === PLATFORM_AI) {
      await discoverAIForFormulas(cwd, result, formulaNames);
    } else {
      await discoverPlatformForFormulas(cwd, cfg.platform, result, formulaNames);
    }
  }

  // Check root files for all formulas
  await discoverRootFilesForFormulas(cwd, result, formulaNames);

  // Only return entries that have actual files discovered
    const filteredResult = new Map<string, typeof result extends Map<infer K, infer V> ? V : never>();
    for (const [name, entry] of result) {
      const hasFiles = entry.aiFiles.length > 0 || 
                       Object.keys(entry.platforms).length > 0 || 
                       (entry.rootFiles && entry.rootFiles.length > 0);
      if (hasFiles) {
        filteredResult.set(name, entry);
      }
    }

  return filteredResult;
}

/**
 * Discover AI files for requested formulas using same logic as uninstall
 */
async function discoverAIForFormulas(
  cwd: string,
  result: Map<string, any>,
  formulaNames: string[]
): Promise<void> {
  const aiDir = PLATFORM_DIRS.AI;
  const fullAIDir = join(cwd, aiDir);

  if (!(await exists(fullAIDir))) return;

  // Use same file discovery as uninstall
  for await (const filePath of walkFiles(fullAIDir)) {
    if (!filePath.endsWith(FILE_PATTERNS.MD_FILES) && !filePath.endsWith(FILE_PATTERNS.MDC_FILES)) {
      continue;
    }

    try {
      const content = await readTextFile(filePath);
      const fm = parseMarkdownFrontmatter(content);
      const formulaName: string | undefined = (fm as any)?.formula?.name || (fm as any)?.formula;

      if (formulaName && formulaNames.includes(formulaName)) {
        const entry = result.get(formulaName)!;
        entry.aiFiles.push(filePath);
        if (!entry.anyPath) entry.anyPath = dirname(filePath);
      }
    } catch {
      // Skip unreadable files
    }
  }

  // Check index.yml marked directories for AI
  for (const formulaName of formulaNames) {
    const matchingDirs = await findMatchingIndexYmlDirsRecursive(fullAIDir, formulaName);
    if (matchingDirs.length > 0) {
      const entry = result.get(formulaName)!;
      // Add directory markers (simplified - just track presence)
      if (!entry.anyPath) entry.anyPath = matchingDirs[0];
    }
  }
}

/**
 * Discover platform files for requested formulas using same logic as uninstall
 */
async function discoverPlatformForFormulas(
  cwd: string,
  platform: string,
  result: Map<string, any>,
  formulaNames: string[]
): Promise<void> {
  const def = getPlatformDefinition(platform as any);
  const platformRoot = join(cwd, def.rootDir);

  for (const [subKey, subDef] of Object.entries(def.subdirs)) {
    const targetDir = join(platformRoot, (subDef as any).path || '');
    if (!(await exists(targetDir))) continue;

    for await (const fp of walkFiles(targetDir)) {
      const allowedExts: string[] = ((subDef as any).readExts) || [FILE_PATTERNS.MD_FILES];
      if (!allowedExts.some((ext) => fp.endsWith(ext))) continue;

      try {
        const content = await readTextFile(fp);
        const fm = parseMarkdownFrontmatter(content);
        const formulaName: string | undefined = (fm as any)?.formula?.name || (fm as any)?.formula;

        if (formulaName && formulaNames.includes(formulaName)) {
          const entry = result.get(formulaName)!;
          entry.platforms[platform] = entry.platforms[platform] || {};

          if (subKey === UNIVERSAL_SUBDIRS.RULES) {
            entry.platforms[platform].rules = entry.platforms[platform].rules || { found: 0 };
            entry.platforms[platform].rules!.found++;
          } else if (subKey === UNIVERSAL_SUBDIRS.COMMANDS) {
            entry.platforms[platform].commands = entry.platforms[platform].commands || { found: 0 };
            entry.platforms[platform].commands!.found++;
          } else if (subKey === UNIVERSAL_SUBDIRS.AGENTS) {
            entry.platforms[platform].agents = entry.platforms[platform].agents || { found: 0 };
            entry.platforms[platform].agents!.found++;
          }

          if (!entry.anyPath) entry.anyPath = dirname(fp);
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Check index.yml marked directories for platform
  for (const formulaName of formulaNames) {
    const matchingDirs = await findMatchingIndexYmlDirsRecursive(platformRoot, formulaName);
    if (matchingDirs.length > 0) {
      const entry = result.get(formulaName)!;
      if (!entry.anyPath) entry.anyPath = matchingDirs[0];
    }
  }
}

/**
 * Discover root files for requested formulas using same logic as uninstall
 */
async function discoverRootFilesForFormulas(
  cwd: string,
  result: Map<string, any>,
  formulaNames: string[]
): Promise<void> {

  console.log('formulaNames', formulaNames);
  const seen = new Set<string>();

  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (!def.rootFile) continue;

    const absPath = join(cwd, def.rootFile);
    if (seen.has(absPath)) continue;
    seen.add(absPath);

    console.log('absPath', absPath);

    if (!(await exists(absPath))) continue;

    try {
      const content = await readTextFile(absPath);
      for (const formulaName of formulaNames) {
        console.log('formulaName', formulaName);
        const extracted = extractFormulaContentFromRootFile(content, formulaName);
        if (extracted) {
          const entry = result.get(formulaName)!;
          // console.log('entry', entry);
          if (!entry.anyPath) entry.anyPath = absPath;
          // Track root file paths
          if (!entry.rootFiles!.includes(absPath)) {
            entry.rootFiles!.push(absPath);
          }
        }
      }
    } catch (error) {
      // Ignore errors
    }
  }
}

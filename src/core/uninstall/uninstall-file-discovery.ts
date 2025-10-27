import { join } from 'path';
import { FILE_PATTERNS, PLATFORM_AI, PLATFORM_DIRS } from '../../constants/index.js';
import { type UninstallDiscoveredFile } from '../../types/index.js';
import { buildPlatformSearchConfig } from '../discovery/platform-discovery.js';
import { getAllPlatforms, getPlatformDefinition } from '../platforms.js';
import { exists, isDirectory } from '../../utils/fs.js';
import { findFilesByExtension, type Platformish } from '../../utils/file-processing.js';
import { shouldIncludeMarkdownFile } from '../discovery/md-files-discovery.js';
import { readTextFile } from '../../utils/fs.js';
import { parseMarkdownFrontmatter } from '../../utils/md-frontmatter.js';
import { extractFormulaContentFromRootFile } from '../../utils/root-file-extractor.js';
import { findMatchingIndexYmlDirsRecursive } from '../discovery/index-files-discovery.js';

async function discoverLightweightInDir(
  absDir: string,
  platform: Platformish,
  formulaName: string
): Promise<UninstallDiscoveredFile[]> {
  if (!(await exists(absDir)) || !(await isDirectory(absDir))) return [];

  const files = await findFilesByExtension(absDir, [FILE_PATTERNS.MD_FILES, FILE_PATTERNS.MDC_FILES]);
  const results: UninstallDiscoveredFile[] = [];

  for (const f of files) {
    try {
      const content = await readTextFile(f.fullPath);
      const frontmatter = parseMarkdownFrontmatter(content);
      if (!shouldIncludeMarkdownFile(f, frontmatter, platform, formulaName)) continue;

      const sourceDir = platform === PLATFORM_AI ? PLATFORM_DIRS.AI : getPlatformDefinition(platform as any).rootDir;
      results.push({ fullPath: f.fullPath, sourceDir });
    } catch {
      // Skip unreadable/invalid files silently for uninstall
    }
  }

  return results;
}

async function discoverIndexYmlMarkedDirs(
  rootDir: string,
  platform: Platformish,
  formulaName: string
): Promise<UninstallDiscoveredFile[]> {
  const matchingDirs = await findMatchingIndexYmlDirsRecursive(rootDir, formulaName);
  return matchingDirs.map((dir: string) => ({
    fullPath: dir,
    sourceDir: platform
  }));
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
  const configs = await buildPlatformSearchConfig(cwd);
  const results: UninstallDiscoveredFile[] = [];

  // AI directory
  for (const cfg of configs) {
    if (cfg.platform === PLATFORM_AI) {
      const aiFiles = await discoverLightweightInDir(cfg.rulesDir, PLATFORM_AI, formulaName);
      results.push(...aiFiles);

      // Add index.yml marked directories for AI
      const aiIndexDirs = await discoverIndexYmlMarkedDirs(cfg.rulesDir, PLATFORM_AI, formulaName);
      results.push(...aiIndexDirs);
      continue;
    }

    // Platform subdirs
    const def = getPlatformDefinition(cfg.platform as any);
    for (const [subdirName, subdirDef] of Object.entries(def.subdirs)) {
      const subdirPath = join(cwd, def.rootDir, (subdirDef as any).path);
      const files = await discoverLightweightInDir(subdirPath, cfg.platform, formulaName);
      results.push(...files);
    }

    // Add index.yml marked directories for platform
    const platformIndexDirs = await discoverIndexYmlMarkedDirs(join(cwd, def.rootDir), cfg.platform, formulaName);
    results.push(...platformIndexDirs);
  }

  // Root files
  const rootFiles = await discoverLightweightRootFiles(cwd, formulaName);
  results.push(...rootFiles);

  // Dedupe by fullPath
  const map = new Map<string, UninstallDiscoveredFile>();
  for (const f of results) {
    if (!map.has(f.fullPath)) map.set(f.fullPath, f);
  }
  return Array.from(map.values());
}



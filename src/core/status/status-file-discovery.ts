import { join, dirname } from 'path';
import { FILE_PATTERNS } from '../../constants/index.js';
import { buildPlatformSearchConfig } from '../discovery/platform-discovery.js';
import { getPlatformDefinition, getAllPlatforms, isValidUniversalSubdir } from '../platforms.js';
import { exists, walkFiles, readTextFile } from '../../utils/fs.js';
import { extractPackageContentFromRootFile } from '../../utils/root-file-extractor.js';

/**
 * Discover installed packages using same methods as uninstall but optimized for status command
 * Returns detailed file information for packages in the config
 */
export async function discoverPackagesForStatus(
  packageNames: string[]
): Promise<Map<string, {
  aiFiles: string[];
  platforms: Record<string, {
    rules?: { found: number };
    commands?: { found: number };
    agents?: { found: number };
    skills?: { found: number }
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
      agents?: { found: number };
      skills?: { found: number }
    }>;
    rootFiles?: string[];
    anyPath?: string
  }>();

  // Initialize result entries for all requested packages
  for (const packageName of packageNames) {
    result.set(packageName, { aiFiles: [], platforms: {}, rootFiles: [] });
  }

  // Use same platform detection as uninstall
  const configs = await buildPlatformSearchConfig(cwd);

  // Process each platform configuration
  for (const cfg of configs) {
    await discoverPlatformForPackages(cwd, cfg.platform, result, packageNames);
  }

  // Check root files for all packages
  await discoverRootFilesForPackages(cwd, result, packageNames);

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
 * Discover AI files for requested packages using same logic as uninstall
 */
/**
 * Discover platform files for requested packages using same logic as uninstall
 */
async function discoverPlatformForPackages(
  cwd: string,
  platform: string,
  result: Map<string, any>,
  packageNames: string[]
): Promise<void> {
  const def = getPlatformDefinition(platform as any);
  const platformRoot = join(cwd, def.rootDir);

  for (const [subKey, subDef] of Object.entries(def.subdirs)) {
    const targetDir = join(platformRoot, (subDef as any).path || '');
    if (!(await exists(targetDir))) continue;

    for await (const fp of walkFiles(targetDir)) {
      const allowedExts: string[] = (subDef as any).readExts;
      // If readExts is empty, include all files (don't filter by extension)
      if (allowedExts.length > 0 && !allowedExts.some((ext) => fp.endsWith(ext))) continue;

      // Frontmatter support removed - cannot determine package ownership
    }
  }

  // Index.yml support removed
}

/**
 * Discover root files for requested packages using same logic as uninstall
 */
async function discoverRootFilesForPackages(
  cwd: string,
  result: Map<string, any>,
  packageNames: string[]
): Promise<void> {

  const seen = new Set<string>();

  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (!def.rootFile) continue;

    const absPath = join(cwd, def.rootFile);
    if (seen.has(absPath)) continue;
    seen.add(absPath);

    if (!(await exists(absPath))) continue;

    try {
      const content = await readTextFile(absPath);
      for (const packageName of packageNames) {
        const extracted = extractPackageContentFromRootFile(content, packageName);
        if (extracted) {
          const entry = result.get(packageName)!;
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

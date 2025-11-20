import { join } from 'path';
import { isJunk } from 'junk';
import { FILE_PATTERNS } from '../constants/index.js';
import { logger } from './logger.js';
import { exists, readTextFile } from './fs.js';
import { calculateFileHash } from './hash-utils.js';
import { getAllPlatforms, getPlatformDefinition } from '../core/platforms.js';
import { extractPackageContentFromRootFile } from './root-file-extractor.js';
import { getFileMtime } from '../utils/file-processing.js';
import type { DiscoveredFile } from '../types/index.js';

/**
 * Discover root-level AGENTS.md content designated for a specific formula.
 * Only includes content between markers: <!-- formula: <name> --><content><!-- -->
 */
export async function discoverAgentsMdFile(
  cwd: string,
  formulaName: string
): Promise<DiscoveredFile | null> {
  const agentsPath = join(cwd, FILE_PATTERNS.AGENTS_MD);
  if (!(await exists(agentsPath))) {
    return null;
  }

  try {
    const content = await readTextFile(agentsPath);
    const extracted = extractPackageContentFromRootFile(content, formulaName);
    if (!extracted) {
      return null; // No matching section; treat as non-existent
    }

    const mtime = await getFileMtime(agentsPath);
    const contentHash = await calculateFileHash(extracted);

    const discovered: DiscoveredFile = {
      fullPath: agentsPath,
      relativePath: FILE_PATTERNS.AGENTS_MD,
      sourceDir: 'root',
      registryPath: FILE_PATTERNS.AGENTS_MD,
      mtime,
      contentHash
    };

    return discovered;
  } catch (error) {
    logger.warn(`Failed to process root ${FILE_PATTERNS.AGENTS_MD}: ${error}`);
    return null;
  }
}

/**
 * Discover all platform root files at project root and extract package-specific content.
 * Merges CLAUDE.md, GEMINI.md, QWEN.md, WARP.md, and platform AGENTS.md into a single
 * universal AGENTS.md registry path via conflict resolution.
 */
export async function discoverAllRootFiles(
  cwd: string,
  formulaName: string
): Promise<DiscoveredFile[]> {
  const results: DiscoveredFile[] = [];

  // Collect unique root filenames from platform definitions
  const uniqueRootFiles = new Set<string>();
  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) {
      uniqueRootFiles.add(def.rootFile);
    }
  }

  // Iterate unique root files and extract content
  for (const rootFile of uniqueRootFiles) {
    // Skip junk files
    if (isJunk(rootFile)) {
      continue;
    }

    const absPath = join(cwd, rootFile);
    if (!(await exists(absPath))) {
      continue;
    }

    try {
      const content = await readTextFile(absPath);
      const extracted = extractPackageContentFromRootFile(content, formulaName);
      if (!extracted) {
        continue; // No matching section in this root file
      }

      const mtime = await getFileMtime(absPath);
      const contentHash = await calculateFileHash(extracted);

      // Derive a representative platform for this root file (e.g., 'claude' for CLAUDE.md)
      const representativePlatform = (() => {
        for (const p of getAllPlatforms()) {
          const def = getPlatformDefinition(p);
          if (def.rootFile === rootFile) return p;
        }
        return 'root';
      })();

      results.push({
        fullPath: absPath,
        relativePath: rootFile,
        // Use representative platform id so conflict resolution can map to native root filenames
        sourceDir: representativePlatform,
        // Map all root files to universal AGENTS.md target for conflict resolution
        registryPath: FILE_PATTERNS.AGENTS_MD,
        mtime,
        contentHash,
        isRootFile: true  // Mark as root file for special conflict resolution
      });
    } catch (error) {
      logger.warn(`Failed to process root file ${rootFile}: ${error}`);
    }
  }

  return results;
}

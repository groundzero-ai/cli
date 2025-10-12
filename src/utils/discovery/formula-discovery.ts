import { join } from 'path';
import { parseMarkdownFrontmatter } from '../md-frontmatter.js';
import { FILE_PATTERNS, PLATFORM_DIRS, FORMULA_DIRS } from '../../constants/index.js';
import { getLocalFormulasDir } from '../paths.js';
import { logger } from '../logger.js';
import { exists, readTextFile, listDirectories, isDirectory } from '../fs.js';
import { calculateFileHash } from '../hash-utils.js';
import { getAllPlatforms, getPlatformDefinition } from '../../core/platforms.js';
import { extractFormulaContentFromRootFile } from '../root-file-extractor.js';
import { getFileMtime } from './file-processing.js';
import { findFilesByExtension } from './file-processing.js';
import { buildPlatformSearchConfig } from './platform-discovery.js';
import type { DiscoveredFile } from '../../types/index.js';

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
    const extracted = extractFormulaContentFromRootFile(content, formulaName);
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
 * Discover all platform root files at project root and extract formula-specific content.
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
    const absPath = join(cwd, rootFile);
    if (!(await exists(absPath))) {
      continue;
    }

    try {
      const content = await readTextFile(absPath);
      const extracted = extractFormulaContentFromRootFile(content, formulaName);
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

/**
 * Find formulas by name, searching both explicit formula.yml files and frontmatter-based formulas
 */
export async function findFormulas(formulaName: string): Promise<Array<{ fullPath: string; relativePath: string; config: any }>> {
  const cwd = process.cwd();
  const matchingFormulas: Array<{ fullPath: string; relativePath: string; config: any }> = [];

  // Helper function to process markdown files in a directory
  const processMarkdownFiles = async (
    dirPath: string,
    registryPath: string,
    sourceName: string
  ): Promise<void> => {
    if (!(await exists(dirPath)) || !(await isDirectory(dirPath))) {
      return;
    }

    const allMdFiles = await findFilesByExtension(dirPath, FILE_PATTERNS.MD_FILES, dirPath);

    // Process markdown files in parallel
    const filePromises = allMdFiles.map(async (mdFile) => {
      try {
        const content = await readTextFile(mdFile.fullPath);
        const frontmatter = parseMarkdownFrontmatter(content);

        if (frontmatter?.formula?.name === formulaName) {
          // Create a virtual formula.yml config based on frontmatter
          const config = {
            name: formulaName,
            version: '0.1.0' // Default version for frontmatter-based formulas
          };

          return {
            fullPath: mdFile.fullPath, // Use the markdown file as the "formula" location
            relativePath: registryPath ? join(registryPath, mdFile.relativePath) : mdFile.relativePath,
            config
          };
        }
      } catch (error) {
        logger.warn(`Failed to read or parse ${mdFile.relativePath} from ${sourceName}: ${error}`);
      }
      return null;
    });

    const fileResults = await Promise.all(filePromises);
    matchingFormulas.push(...fileResults.filter((result): result is { fullPath: string; relativePath: string; config: any } => result !== null));
  };

  // Search in .groundzero/formulas directory for explicit formula.yml files
  const formulasDir = getLocalFormulasDir(cwd);
  if (await exists(formulasDir) && await isDirectory(formulasDir)) {
    const formulaDirs = await listDirectories(formulasDir);

    // Process formula directories in parallel
    const formulaPromises = formulaDirs.map(async (formulaDir) => {
      const formulaYmlPath = join(formulasDir, formulaDir, FILE_PATTERNS.FORMULA_YML);
      if (await exists(formulaYmlPath)) {
        try {
          const { parseFormulaYml } = await import('../formula-yml.js');
          const config = await parseFormulaYml(formulaYmlPath);
          if (config.name === formulaName) {
            return {
              fullPath: formulaYmlPath,
              relativePath: join(PLATFORM_DIRS.GROUNDZERO, FORMULA_DIRS.FORMULAS, formulaDir, FILE_PATTERNS.FORMULA_YML),
              config
            };
          }
        } catch (error) {
          logger.warn(`Failed to parse formula.yml at ${formulaYmlPath}: ${error}`);
        }
      }
      return null;
    });

    const formulaResults = await Promise.all(formulaPromises);
    matchingFormulas.push(...formulaResults.filter((result): result is { fullPath: string; relativePath: string; config: any } => result !== null));
  }

  // Search in AI directory for markdown files with matching frontmatter
  const aiDir = join(cwd, PLATFORM_DIRS.AI);
  await processMarkdownFiles(aiDir, '', PLATFORM_DIRS.AI);

  // Search in platform-specific directories (rules, commands, agents)
  const platformConfigs = await buildPlatformSearchConfig(cwd);

  for (const config of platformConfigs) {
    // Skip AI directory since it's handled above
    if (config.name === PLATFORM_DIRS.AI) {
      continue;
    }

    // Process all subdirs for this platform
    const definition = getPlatformDefinition(config.platform as any);
    for (const [subdirName, subdirDef] of Object.entries(definition.subdirs)) {
      const subdirPath = join(config.rootDir, subdirDef.path);
      const registryPath = join(config.registryPath, subdirName);

      await processMarkdownFiles(subdirPath, registryPath, config.name);
    }
  }

  // Deduplicate results based on fullPath to avoid duplicates
  const uniqueFormulas = new Map<string, { fullPath: string; relativePath: string; config: any }>();

  for (const formula of matchingFormulas) {
    if (!uniqueFormulas.has(formula.fullPath)) {
      uniqueFormulas.set(formula.fullPath, formula);
    }
  }

  return Array.from(uniqueFormulas.values());
}

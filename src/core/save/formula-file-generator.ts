import { basename, dirname, join } from "path";

import { FILE_PATTERNS, PLATFORM_DIRS } from "../../constants/index.js";
import { DiscoveredFile, FormulaFile, FormulaYml } from "../../types";
import { getAllPlatforms, getPlatformDefinition } from "../platforms.js";
import { resolveRootFileConflicts } from "../../utils/root-conflict-resolution.js";
import { resolvePlatformFileConflicts } from "../../utils/platform-conflict-resolution.js";
import { writeFormulaYml } from "../../utils/formula-yml.js";
import { exists, readTextFile, writeTextFile } from "../../utils/fs.js";
import { LOG_PREFIXES, UTF8_ENCODING } from "./constants.js";
import { extractFormulaSection } from "../../utils/root-file-extractor.js";
import { splitPlatformFileFrontmatter } from "../../utils/platform-frontmatter-split.js";
import { FormulaYmlInfo } from "./formula-yml-generator.js";

/**
 * Process discovered files and return formula file entries
 */
async function processFiles(formulaConfig: FormulaYml, discoveredFiles: DiscoveredFile[]): Promise<FormulaFile[]> {
  // Process discovered files in parallel
  // Build dynamic set of platform root filenames from platform definitions
  const rootFilenamesSet = (() => {
    const set = new Set<string>();
    for (const platform of getAllPlatforms()) {
      const def = getPlatformDefinition(platform);
      if (def.rootFile) set.add(def.rootFile);
    }
    return set;
  })();

  const filePromises = discoveredFiles.map(async (file) => {
    const originalContent = await readTextFile(file.fullPath);

    // Special handling for root files: store only the section body (no markers)
    // Supports AGENTS.md and platform-native root files
    if (file.fullPath.endsWith(FILE_PATTERNS.MD_FILES) && rootFilenamesSet.has(basename(file.fullPath))) {
      const extracted = extractFormulaSection(originalContent, formulaConfig.name);
      if (!extracted) {
        return null as any;
      }

      const sectionBody = extracted.sectionBody.trim();

      return {
        path: file.registryPath,
        content: sectionBody,
        encoding: UTF8_ENCODING
      };
    }


    // Only markdown files proceed with frontmatter logic
    if (!file.fullPath.endsWith(FILE_PATTERNS.MD_FILES)) {
      return {
        path: file.registryPath,
        content: originalContent,
        encoding: UTF8_ENCODING
      };
    }

    // Try platform frontmatter splitting first
    const splitResult = await splitPlatformFileFrontmatter(
      file,
      formulaConfig,
      rootFilenamesSet,
      LOG_PREFIXES.UPDATED
    );

    if (splitResult) {
      return splitResult;
    }

    return {
      path: file.registryPath,
      content: originalContent,
      encoding: UTF8_ENCODING
    };
  });

  const results = await Promise.all(filePromises);
  // Flatten any arrays returned (when YAML + MD are both returned)
  const flattened: FormulaFile[] = [];
  for (const r of results) {
    if (!r) continue;
    if (Array.isArray(r)) {
      for (const f of r) if (f) flattened.push(f);
    } else {
      flattened.push(r as FormulaFile);
    }
  }

  // Deduplicate universal .md files by path, but keep all .yml files
  const deduped = new Map<string, FormulaFile>();
  for (const file of flattened) {
    if (!deduped.has(file.path)) {
      deduped.set(file.path, file);
      continue;
    }
    // Keep the first .md instance and allow distinct .yml files to accumulate
    if (file.path.endsWith(FILE_PATTERNS.YML_FILE)) {
      deduped.set(file.path, file);
    }
  }
  return Array.from(deduped.values());
}

/**
 * Create the formula.yml file entry for the formula files array
 */
async function createFormulaYmlFile(formulaInfo: FormulaYmlInfo): Promise<FormulaFile> {
  // Write and read the formula.yml content
  await writeFormulaYml(formulaInfo.fullPath, formulaInfo.config);
  const content = await readTextFile(formulaInfo.fullPath);

  return {
    path: FILE_PATTERNS.FORMULA_YML,
    content,
    encoding: UTF8_ENCODING
  };
}

/**
 * Create formula files array with unified discovery results
 */
async function createFormulaFilesUnified(
  formulaInfo: FormulaYmlInfo,
  discoveredFiles: DiscoveredFile[]
): Promise<FormulaFile[]> {
  const formulaFiles: FormulaFile[] = [];

  // Add formula.yml as the first file
  const formulaYmlFile = await createFormulaYmlFile(formulaInfo);
  formulaFiles.push(formulaYmlFile);

  // Add README.md if it exists in the formula directory
  const readmePath = join(dirname(formulaInfo.fullPath), FILE_PATTERNS.README_MD);
  if (await exists(readmePath)) {
    const readmeContent = await readTextFile(readmePath);
    formulaFiles.push({
      path: FILE_PATTERNS.README_MD,
      content: readmeContent,
      encoding: UTF8_ENCODING
    });
  }

  // Process discovered files of all types
  const processedFiles = await processFiles(formulaInfo.config, discoveredFiles);
  formulaFiles.push(...processedFiles);

  return formulaFiles;
}

/**
 * Process discovered files: resolve conflicts and create formula files array
 */
export async function createFormulaFiles(
  formulaInfo: FormulaYmlInfo,
  discoveredFiles: DiscoveredFile[]
): Promise<FormulaFile[]> {
  // Separate root files from normal files
  const rootFiles = discoveredFiles.filter(f => f.isRootFile);
  const normalFiles = discoveredFiles.filter(f => !f.isRootFile);

  // Build root filenames set (for platform split eligibility checks)
  const rootFilenamesSet = (() => {
    const set = new Set<string>();
    for (const platform of getAllPlatforms()) {
      const def = getPlatformDefinition(platform);
      if (def.rootFile) set.add(def.rootFile);
    }
    return set;
  })();

  // Separate files that should bypass conflict resolution to allow per-platform YAML splitting
  const platformSplitFiles: DiscoveredFile[] = [];
  const regularFiles: DiscoveredFile[] = [];

  for (const file of normalFiles) {
    const isPlatformDir = file.sourceDir !== PLATFORM_DIRS.AI;
    const isRootLike = rootFilenamesSet.has(basename(file.fullPath));
    const isForcedPlatformSpecific = file.forcePlatformSpecific === true;

    if (isPlatformDir && !isRootLike && !isForcedPlatformSpecific) {
      // This file will undergo platform frontmatter splitting; include as-is (no conflict resolution)
      platformSplitFiles.push(file);
    } else {
      regularFiles.push(file);
    }
  }

  // Resolve root file conflicts separately
  const resolvedRootFiles = await resolveRootFileConflicts(rootFiles, formulaInfo.config.version, /* silent */ true);

  // Resolve conflicts for regular files only
  const resolvedRegularFiles = await resolvePlatformFileConflicts(regularFiles, formulaInfo.config.version, /* silent */ true);

  // Combine: resolved root + resolved regular + platform-split (unresolved) files
  const combinedFiles = [...resolvedRootFiles, ...resolvedRegularFiles, ...platformSplitFiles];

  // Create formula files array
  return await createFormulaFilesUnified(formulaInfo, combinedFiles);
}

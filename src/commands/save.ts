import { Command } from 'commander';
import { join, basename, dirname, isAbsolute } from 'path';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { updateMarkdownWithFormulaFrontmatter } from '../utils/md-frontmatter.js';
import { ensureRegistryDirectories, getFormulaVersionPath, hasFormulaVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { getLocalFormulaDir } from '../utils/paths.js';
import { ensureLocalGroundZeroStructure, createBasicFormulaYml, addFormulaToYml } from '../utils/formula-management.js';
import { FILE_PATTERNS } from '../constants/index.js';

import { generateLocalVersion, isLocalVersion, extractBaseVersion } from '../utils/version-generator.js';
import { resolveTargetDirectory, resolveTargetFilePath } from '../utils/platform-mapper.js';
import { resolvePlatformFileConflicts } from '../utils/platform-conflict-resolution.js';
import { resolveRootFileConflicts } from '../utils/root-conflict-resolution.js';
import { discoverFilesForPattern } from '../utils/discovery/discovery-core.js';
import { discoverAllRootFiles, findFormulas } from '../utils/discovery/formula-discovery.js';
import { getInstalledFormulaVersion } from '../core/groundzero.js';
import { getAllPlatforms, getPlatformDefinition } from '../core/platforms.js';
import { createCaretRange } from '../utils/version-ranges.js';
import { getLatestFormulaVersion } from '../core/directory.js';
import type { DiscoveredFile } from '../types/index.js';
import { exists, readTextFile, writeTextFile, ensureDir } from '../utils/fs.js';
import { postSavePlatformSync } from '../utils/platform-sync.js';
import { syncRootFiles } from '../utils/root-file-sync.js';
import { ensureRootMarkerIdAndExtract, buildOpenMarker, CLOSE_MARKER } from '../utils/root-file-extractor.js';
import { getLocalFormulaYmlPath } from '../utils/paths.js';
import { autoNormalizeDirectoryPath } from '../utils/path-normalization.js';
import { validateFormulaName, SCOPED_FORMULA_REGEX } from '../utils/formula-validation.js';
import { normalizeFormulaName, areFormulaNamesEquivalent } from '../utils/formula-name-normalization.js';
import { PLATFORM_DIRS } from '../constants/index.js';
import { splitPlatformFileFrontmatter } from '../utils/platform-frontmatter-split.js';

// Constants
const UTF8_ENCODING = 'utf8' as const;
const DEFAULT_VERSION = '0.1.0';
const VERSION_TYPE_STABLE = 'stable';

const BUMP_TYPES = {
  PATCH: 'patch',
  MINOR: 'minor',
  MAJOR: 'major'
} as const;

type BumpType = typeof BUMP_TYPES[keyof typeof BUMP_TYPES];

const ERROR_MESSAGES = {
  INVALID_FORMULA_SYNTAX: 'Invalid formula syntax: %s. Use format: formula@version',
  VERSION_EXISTS: 'Version %s already exists. Use --force to overwrite.',
  SAVE_FAILED: 'Failed to save formula',
  OPERATION_CANCELLED: 'Operation cancelled by user',
  INVALID_VERSION_FORMAT: 'Invalid version format: %s',
  INVALID_BUMP_TYPE: 'Invalid bump type: %s. Must be \'patch\', \'minor\', or \'major\'.',
  INVALID_VERSION_TYPE: 'Invalid version type: %s. Only \'%s\' is supported.',
  PARSE_FORMULA_FAILED: 'Failed to parse existing formula.yml at %s: %s'
} as const;

const LOG_PREFIXES = {
  CREATED: '✓ Created formula.yml in',
  FOUND: '✓ Found existing formula.yml',
  NAME: '✓ Name:',
  VERSION: '✓ Version:',
  FILES: '✓ Found',
  FILES_SUFFIX: 'markdown files',
  RESOLVED: '✓ Conflicts resolved, processed',
  SAVED: '✓ Saved',
  UPDATED: '✓ Updated frontmatter in',
  EXPLICIT_VERSION: '✓ Using explicit version:',
  PRERELEASE: '✓ New formula, setting to prerelease:',
  BUMP_STABLE: '✓ Bumping to stable version:',
  BUMP_PRERELEASE: '✓ Bumping to prerelease version:',
  CONVERT_STABLE: '✓ Converting to stable version:',
  OVERWRITE_STABLE: '✓ Overwriting stable version:',
  INCREMENT_PRERELEASE: '✓ Incrementing prerelease version:',
  AUTO_INCREMENT: '✓ Auto-incrementing to patch prerelease:',
  WARNING: '⚠️  Version',
  WARNING_SUFFIX: 'is already stable.',
  ARROW_SEPARATOR: ' → '
} as const;


/**
 * Parse formula inputs to handle three usage patterns:
 * 1. Explicit name + directory: formula-name /path/to/dir
 * 2. Directory only: /path/to/dir
 * 3. Formula name only: formula-name or formula-name@version
 */
function parseFormulaInputs(formulaName: string, directory?: string): {
  name: string;
  version?: string;
  directoryPath?: string;
} {
  // Pattern 1: Explicit name + directory
  if (directory) {
    validateFormulaName(formulaName);
    return {
      name: normalizeFormulaName(formulaName),
      directoryPath: directory
    };
  }

  // Check if this looks like a scoped formula name (@scope/name)
  // Handle this before path normalization to avoid treating it as a directory
  const scopedMatch = formulaName.match(SCOPED_FORMULA_REGEX);
  if (scopedMatch) {
    validateFormulaName(formulaName);
    return {
      name: normalizeFormulaName(formulaName)
    };
  }

  // Auto-normalize potential directory paths
  const normalizedInput = autoNormalizeDirectoryPath(formulaName);

  // Pattern 2: Directory path as first argument (now catches auto-normalized paths)
  if (isAbsolute(normalizedInput) || normalizedInput.startsWith('./') || normalizedInput.startsWith('../')) {
    const directoryPath = normalizedInput;
    const name = basename(directoryPath);

    if (!name) {
      throw new ValidationError(`Invalid directory path: ${formulaName}`);
    }

    validateFormulaName(name);

    return {
      name: normalizeFormulaName(name),
      directoryPath
    };
  }

  // Pattern 3: Formula name with optional version
  const atIndex = normalizedInput.lastIndexOf('@');

  if (atIndex === -1) {
    validateFormulaName(normalizedInput);
    return {
      name: normalizeFormulaName(normalizedInput)
    };
  }

  const name = normalizedInput.substring(0, atIndex);
  const version = normalizedInput.substring(atIndex + 1);

  if (!name || !version) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_FORMULA_SYNTAX.replace('%s', formulaName));
  }

  validateFormulaName(name);

  return {
    name: normalizeFormulaName(name),
    version
  };
}

/**
 * Create formula.yml automatically in a directory without user prompts
 * Reuses init command logic but makes it non-interactive
 */
async function createFormulaYmlInDirectory(formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean }> {
  const cwd = process.cwd();
  
  // Ensure the target directory exists (including formulas subdirectory)
  await ensureLocalGroundZeroStructure(cwd);
  await ensureDir(formulaDir);
  
  // Create formula.yml in the formula directory (not the main .groundzero directory)
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
  
  // Create default formula config
  const formulaConfig: FormulaYml = {
    name: normalizeFormulaName(formulaName),
    version: DEFAULT_VERSION
  };
  
  // Create the formula.yml file
  await writeFormulaYml(formulaYmlPath, formulaConfig);
  console.log(`${LOG_PREFIXES.CREATED} ${formulaDir}`);
  console.log(`${LOG_PREFIXES.NAME} ${formulaConfig.name}`);
  console.log(`${LOG_PREFIXES.VERSION} ${formulaConfig.version}`);
  
  return {
    fullPath: formulaYmlPath,
    config: formulaConfig,
    isNewFormula: true
  };
}

/**
 * Get or create formula configuration in the specified directory
 * @param cwd - Current working directory
 * @param formulaDir - Directory where formula.yml should be located
 * @param formulaName - Name of the formula
 * @returns Formula configuration info
 */
async function getOrCreateFormulaConfig(cwd: string, formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean; isRootFormula: boolean }> {
  // Check if this is a root formula
  const rootFormulaPath = getLocalFormulaYmlPath(cwd);
  if (await exists(rootFormulaPath)) {
    try {
      const rootConfig = await parseFormulaYml(rootFormulaPath);
      if (areFormulaNamesEquivalent(rootConfig.name, formulaName)) {
        logger.debug('Detected root formula match');
        console.log(`✓ Found root formula ${rootConfig.name}@${rootConfig.version}`);
        return {
          fullPath: rootFormulaPath,
          config: rootConfig,
          isNewFormula: false,
          isRootFormula: true
        };
      }
    } catch (error) {
      // If root formula.yml is invalid, continue to sub-formula logic
      logger.warn(`Failed to parse root formula.yml: ${error}`);
    }
  }

  // Not a root formula - use sub-formula logic
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    logger.debug('Found existing formula.yml, parsing...');
    try {
      const formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(`✓ Found existing formula ${formulaConfig.name}@${formulaConfig.version}`);

      return {
        fullPath: formulaYmlPath,
        config: formulaConfig,
        isNewFormula: false,
        isRootFormula: false
      };
    } catch (error) {
      throw new ValidationError(ERROR_MESSAGES.PARSE_FORMULA_FAILED.replace('%s', formulaYmlPath).replace('%s', String(error)));
    }
  } else {
    logger.debug('No formula.yml found, creating automatically...');
    const result = await createFormulaYmlInDirectory(formulaDir, formulaName);
    return {
      ...result,
      isRootFormula: false
    };
  }
}




/**
 * Process discovered files: resolve conflicts and create formula files array
 */
async function processDiscoveredFiles(
  formulaYmlPath: string,
  formulaConfig: FormulaYml,
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
  const resolvedRootFiles = await resolveRootFileConflicts(rootFiles, formulaConfig.version, /* silent */ true);

  // Resolve conflicts for regular files only
  const resolvedRegularFiles = await resolvePlatformFileConflicts(regularFiles, formulaConfig.version, /* silent */ true);

  // Combine: resolved root + resolved regular + platform-split (unresolved) files
  const combinedFiles = [...resolvedRootFiles, ...resolvedRegularFiles, ...platformSplitFiles];

  // Create formula files array
  return await createFormulaFilesUnified(formulaYmlPath, formulaConfig, combinedFiles);
}


/**
 * Main implementation of the save formula command
 * Handles three usage patterns: explicit name+directory, directory-only, and formula name
 * @param formulaName - Formula name or directory path
 * @param directory - Optional directory path when using explicit name+directory pattern
 * @param versionType - Optional version type ('stable')
 * @param options - Command options (force, bump, etc.)
 * @returns Promise resolving to command result
 */
async function saveFormulaCommand(
  formulaName: string,
  directory?: string,
  versionType?: string,
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();

  // Early include/dev-include validation and pre-save (only for top-level invocations)
  const includeList = options?.include ?? [];
  const includeDevList = options?.includeDev ?? [];
  const hasIncludes = includeList.length > 0 || includeDevList.length > 0;

  if (hasIncludes) {
    // Validate existence first
    const uniqueNames = new Set<string>([...includeList, ...includeDevList]);
    for (const dep of uniqueNames) {
      const matches = await findFormulas(dep);
      if (!matches || matches.length === 0) {
        throw new ValidationError(`${dep} not found, please create or install it first.`);
      }
    }

    // Pre-save all included formulas first (skip linking to avoid premature writes)
    for (const dep of uniqueNames) {
      const res = await saveFormulaCommand(dep, undefined, undefined, {
        force: options?.force,
        bump: options?.bump,
        skipProjectLink: true
      });
      if (!res.success) {
        return res;
      }
    }
  }

  // Parse inputs to determine the pattern being used
  const { name, version: explicitVersion, directoryPath } = parseFormulaInputs(formulaName, directory);

  logger.debug(`Saving formula with name: ${name}`, { explicitVersion, directoryPath, options });

  // Initialize formula environment
  await ensureRegistryDirectories();
  await createBasicFormulaYml(cwd);

  // Get formula configuration based on input pattern
  const formulaDir = getLocalFormulaDir(cwd, name);
  const formulaInfo = await getOrCreateFormulaConfig(cwd, formulaDir, name);
  const formulaYmlPath = formulaInfo.fullPath;
  let formulaConfig = formulaInfo.config;
  const isRootFormula = formulaInfo.isRootFormula;

  logger.debug(`Found formula.yml at: ${formulaYmlPath}`, { isRootFormula });

  // Determine target version
  const targetVersion = await determineTargetVersion(explicitVersion, versionType, options, formulaInfo.isNewFormula ? undefined : formulaConfig.version);

  // Check if version already exists (unless force is used)
  if (!options?.force) {
    const versionExists = await hasFormulaVersion(name, targetVersion);
    if (versionExists) {
      throw new Error(ERROR_MESSAGES.VERSION_EXISTS.replace('%s', targetVersion));
    }
  }

  // Update formula config with new version
  formulaConfig = { ...formulaConfig, version: targetVersion };

  // Inject includes into this formula's own formula.yml (dependencies)
  if (hasIncludes) {
    // Filter out self-references for root formulas
    const filteredIncludes = includeList.filter(dep => dep !== formulaConfig.name);
    const filteredDevIncludes = includeDevList.filter(dep => dep !== formulaConfig.name);

    // Warn if self-references were filtered
    const selfReferences = [...includeList, ...includeDevList].filter(dep => dep === formulaConfig.name);
    if (selfReferences.length > 0) {
      logger.warn(`Skipping self-reference: ${formulaConfig.name} cannot depend on itself`);
    }

    // Ensure arrays exist
    if (!formulaConfig.formulas) formulaConfig.formulas = [];
    if (!formulaConfig['dev-formulas']) formulaConfig['dev-formulas'] = [];

    // Helper to upsert dependency into a target array
    const upsertDependency = (arr: { name: string; version: string }[], name: string, versionRange: string) => {
      const idx = arr.findIndex(d => d.name === name);
      if (idx >= 0) {
        arr[idx] = { name, version: versionRange };
      } else {
        arr.push({ name, version: versionRange });
      }
    };

    // Build caret versions from installed or latest local registry
    const computeCaretRange = async (dep: string): Promise<string> => {
      const installed = await getInstalledFormulaVersion(dep, cwd);
      let version = installed || await getLatestFormulaVersion(dep) || DEFAULT_VERSION;
      const base = extractBaseVersion(version);
      return createCaretRange(base);
    };

    // First: add normal includes to formulas
    for (const dep of filteredIncludes) {
      const range = await computeCaretRange(dep);
      upsertDependency(formulaConfig.formulas!, dep, range);
    }

    // Then: add dev includes to dev-formulas and remove from formulas if present
    for (const dep of filteredDevIncludes) {
      const range = await computeCaretRange(dep);
      upsertDependency((formulaConfig as any)['dev-formulas']!, dep, range);
      const idx = formulaConfig.formulas!.findIndex(d => d.name === dep);
      if (idx >= 0) {
        formulaConfig.formulas!.splice(idx, 1);
      }
    }
  }

  // Discover and include MD files using appropriate logic
  let discoveredFiles = await discoverFilesForPattern(formulaDir, formulaConfig.name, directoryPath);

  // Discover all platform root files (AGENTS.md, CLAUDE.md, GEMINI.md, etc.) at project root
  const rootFilesDiscovered = await discoverAllRootFiles(cwd, formulaConfig.name);
  if (rootFilesDiscovered.length > 0) {
    discoveredFiles.push(...rootFilesDiscovered);
  }

  // Process discovered files and create formula files array
  const formulaFiles = await processDiscoveredFiles(formulaYmlPath, formulaConfig, discoveredFiles);

  // Save formula to local registry
  const saveResult = await saveFormulaToRegistry(
    formulaConfig,
    formulaFiles,
    formulaYmlPath,
    options?.force,
    /* silent */ true
  );

  if (!saveResult.success) {
    return { success: false, error: saveResult.error || ERROR_MESSAGES.SAVE_FAILED };
  }

  // Sync universal files across detected platforms
  const syncResult = await postSavePlatformSync(cwd, formulaFiles);

  // Sync root files across detected platforms
  const rootSyncResult = await syncRootFiles(cwd, formulaFiles, formulaConfig.name);

  // Finalize the save operation
  // Don't add root formula to itself as a dependency
  if (!options?.skipProjectLink && !isRootFormula) {
    await addFormulaToYml(cwd, formulaConfig.name, formulaConfig.version, /* isDev */ false, /* originalVersion */ undefined, /* silent */ true);
  }
  
  // Display appropriate message based on formula type
  const formulaType = isRootFormula ? 'root formula' : 'formula';
  console.log(`${LOG_PREFIXES.SAVED} ${formulaConfig.name}@${formulaConfig.version} (${formulaType}, ${formulaFiles.length} files):`);
  if (formulaFiles.length > 0) {
    const savedPaths = formulaFiles.map(f => f.path);
    const sortedSaved = [...savedPaths].sort((a, b) => a.localeCompare(b));
    for (const savedPath of sortedSaved) {
      console.log(`   ├── ${savedPath}`);
    }
  }

  // Display platform sync results
  const totalCreated = syncResult.created.length + rootSyncResult.created.length;
  const totalUpdated = syncResult.updated.length + rootSyncResult.updated.length;

  if (totalCreated > 0) {
    const allCreated = [...syncResult.created, ...rootSyncResult.created].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync created ${totalCreated} files:`);
    for (const createdFile of allCreated) {
      console.log(`   ├── ${createdFile}`);
    }
  }

  if (totalUpdated > 0) {
    const allUpdated = [...syncResult.updated, ...rootSyncResult.updated].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync updated ${totalUpdated} files:`);
    for (const updatedFile of allUpdated) {
      console.log(`   ├── ${updatedFile}`);
    }
  }

  return { success: true, data: formulaConfig };
}

/**
 * Create the formula.yml file entry for the formula files array
 */
async function createFormulaYmlFile(formulaYmlPath: string, formulaConfig: FormulaYml): Promise<FormulaFile> {
  // Write and read the formula.yml content
  await writeFormulaYml(formulaYmlPath, formulaConfig);
  const content = await readTextFile(formulaYmlPath);

  return {
    path: FILE_PATTERNS.FORMULA_YML,
    content,
    encoding: UTF8_ENCODING
  };
}

/**
 * Process discovered markdown files and return formula file entries
 */
async function processMarkdownFiles(formulaConfig: FormulaYml, discoveredFiles: DiscoveredFile[]): Promise<FormulaFile[]> {
  // Process discovered MD files in parallel
  // Build dynamic set of platform root filenames from platform definitions
  const rootFilenamesSet = (() => {
    const set = new Set<string>();
    for (const platform of getAllPlatforms()) {
      const def = getPlatformDefinition(platform);
      if (def.rootFile) set.add(def.rootFile);
    }
    return set;
  })();

  const mdFilePromises = discoveredFiles.map(async (mdFile) => {
    const originalContent = await readTextFile(mdFile.fullPath);

    // Special handling for root files: ensure marker id and include markers in registry content
    // Supports AGENTS.md and platform-native root files
    if (rootFilenamesSet.has(basename(mdFile.fullPath))) {
      const ensured = ensureRootMarkerIdAndExtract(originalContent, formulaConfig.name);
      if (!ensured) {
        return null as any;
      }

      // If source content changed (id added/updated), write it back to the workspace
      if (ensured.updatedContent !== originalContent) {
        await writeTextFile(mdFile.fullPath, ensured.updatedContent);
        console.log(`${LOG_PREFIXES.UPDATED} ${mdFile.relativePath}`);
      }

      const openMarker = buildOpenMarker(formulaConfig.name, ensured.id);
      const wrapped = `${openMarker}\n${ensured.sectionBody}\n${CLOSE_MARKER}\n`;

      return {
        path: mdFile.registryPath,
        content: wrapped,
        encoding: UTF8_ENCODING
      };
    }

    // Try platform frontmatter splitting first
    const splitResult = await splitPlatformFileFrontmatter(
      mdFile,
      formulaConfig,
      rootFilenamesSet,
      LOG_PREFIXES.UPDATED
    );

    if (splitResult) {
      return splitResult;
    }

    const updatedContent = updateMarkdownWithFormulaFrontmatter(originalContent, { name: formulaConfig.name, ensureId: true });

    if (updatedContent !== originalContent) {
      await writeTextFile(mdFile.fullPath, updatedContent);
      console.log(`${LOG_PREFIXES.UPDATED} ${mdFile.relativePath}`);
    }

    return {
      path: mdFile.registryPath,
      content: updatedContent,
      encoding: UTF8_ENCODING
    };
  });

  const results = await Promise.all(mdFilePromises);
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
    if (file.path.endsWith('.yml')) {
      deduped.set(file.path, file);
    }
  }
  return Array.from(deduped.values());
}

/**
 * Create formula files array with unified discovery results
 */
async function createFormulaFilesUnified(
  formulaYmlPath: string,
  formulaConfig: FormulaYml,
  discoveredFiles: DiscoveredFile[]
): Promise<FormulaFile[]> {
  const formulaFiles: FormulaFile[] = [];

  // Add formula.yml as the first file
  const formulaYmlFile = await createFormulaYmlFile(formulaYmlPath, formulaConfig);
  formulaFiles.push(formulaYmlFile);

  // Add README.md if it exists in the formula directory
  const readmePath = join(dirname(formulaYmlPath), FILE_PATTERNS.README_MD);
  if (await exists(readmePath)) {
    const readmeContent = await readTextFile(readmePath);
    formulaFiles.push({
      path: FILE_PATTERNS.README_MD,
      content: readmeContent,
      encoding: UTF8_ENCODING
    });
  }

  // Process discovered MD files
  const processedMdFiles = await processMarkdownFiles(formulaConfig, discoveredFiles);
  formulaFiles.push(...processedMdFiles);

  return formulaFiles;
}



/**
 * Determine target version based on input, version type, and options
 */
async function determineTargetVersion(
  explicitVersion?: string,
  versionType?: string,
  options?: SaveOptions,
  currentVersion?: string
): Promise<string> {
  if (explicitVersion) {
    console.log(`${LOG_PREFIXES.EXPLICIT_VERSION} ${explicitVersion}`);
    return explicitVersion;
  }

  if (!currentVersion) {
    const prereleaseVersion = generateLocalVersion(DEFAULT_VERSION);
    console.log(`${LOG_PREFIXES.PRERELEASE} ${prereleaseVersion}`);
    return prereleaseVersion;
  }

  if (options?.bump) {
    if (versionType === VERSION_TYPE_STABLE) {
      const bumpedVersion = bumpToStable(currentVersion, options.bump);
      console.log(`${LOG_PREFIXES.BUMP_STABLE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${bumpedVersion}`);
      return bumpedVersion;
    } else {
      const bumpedVersion = bumpToPrerelease(currentVersion, options.bump);
      console.log(`${LOG_PREFIXES.BUMP_PRERELEASE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${bumpedVersion}`);
      return bumpedVersion;
    }
  }

  if (versionType === VERSION_TYPE_STABLE) {
    if (isLocalVersion(currentVersion)) {
      const stableVersion = extractBaseVersion(currentVersion);
      console.log(`${LOG_PREFIXES.CONVERT_STABLE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${stableVersion}`);
      return stableVersion;
    } else {
      // Already stable - auto bump to next patch version
      const nextStable = calculateBumpedVersion(currentVersion, 'patch');
      console.log(`${LOG_PREFIXES.BUMP_STABLE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${nextStable}`);
      return nextStable;
    }
  }

  // Default smart increment behavior
  if (isLocalVersion(currentVersion)) {
    const localVersion = generateLocalVersion(extractBaseVersion(currentVersion));
    console.log(`${LOG_PREFIXES.INCREMENT_PRERELEASE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${localVersion}`);
    return localVersion;
  } else {
    // For other stable versions, bump patch and then generate prerelease
    const nextPatchVersion = calculateBumpedVersion(currentVersion, 'patch');
    const localVersion = generateLocalVersion(nextPatchVersion);
    console.log(`${LOG_PREFIXES.AUTO_INCREMENT} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${localVersion}`);
    return localVersion;
  }
}


/**
 * Bump version to prerelease (default behavior for --bump)
 * @param version - The current version string
 * @param bumpType - The type of bump to apply
 * @returns A new prerelease version string
 */
function bumpToPrerelease(version: string, bumpType: BumpType): string {
  const baseVersion = extractBaseVersion(version);
  const bumpedBase = calculateBumpedVersion(baseVersion, bumpType);
  return generateLocalVersion(bumpedBase);
}

/**
 * Bump version to stable (when combined with 'stable' argument)
 * @param version - The current version string
 * @param bumpType - The type of bump to apply
 * @returns A new stable version string
 */
function bumpToStable(version: string, bumpType: BumpType): string {
  const baseVersion = extractBaseVersion(version);
  return calculateBumpedVersion(baseVersion, bumpType);
}

/**
 * Calculate bumped version based on type (stable output)
 * @param version - The base version string to bump
 * @param bumpType - The type of bump to apply ('patch', 'minor', or 'major')
 * @returns The bumped version string
 * @throws ValidationError if version format is invalid or bump type is unknown
 */
function calculateBumpedVersion(version: string, bumpType: BumpType): string {
  // Extract base version (remove any prerelease identifiers and build metadata)
  const baseVersion = version.split('-')[0].split('+')[0];
  const parts = baseVersion.split('.').map(Number);

  // Validate that we have valid numbers
  if (parts.some(isNaN)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_VERSION_FORMAT.replace('%s', version));
  }

  switch (bumpType) {
    case 'patch':
      return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2] + 1}` : baseVersion;
    case 'minor':
      return parts.length >= 2 ? `${parts[0]}.${parts[1] + 1}.0` : baseVersion;
    case 'major':
      return parts.length >= 1 ? `${parts[0] + 1}.0.0` : baseVersion;
    default:
      throw new ValidationError(ERROR_MESSAGES.INVALID_BUMP_TYPE.replace('%s', bumpType));
  }
}

/**
 * Save formula to local registry
 */
async function saveFormulaToRegistry(
  config: FormulaYml, 
  files: FormulaFile[], 
  formulaYmlPath: string,
  force?: boolean,
  silent?: boolean
): Promise<{ success: boolean; error?: string; updatedConfig?: FormulaYml }> {
  try {
    // Ensure formula name is normalized for consistent registry paths
    const normalizedConfig = { ...config, name: normalizeFormulaName(config.name) };
    const targetPath = getFormulaVersionPath(normalizedConfig.name, normalizedConfig.version);
    await ensureDir(targetPath);
    
    // Group files by target directory
    const directoryGroups = new Map<string, FormulaFile[]>();
    
    for (const file of files) {
      const targetDir = resolveTargetDirectory(targetPath, file.path);
      if (!directoryGroups.has(targetDir)) {
        directoryGroups.set(targetDir, []);
      }
      directoryGroups.get(targetDir)!.push(file);
    }
    
    // Save files in parallel by directory
    const savePromises = Array.from(directoryGroups.entries()).map(async ([dir, dirFiles]) => {
      await ensureDir(dir);
      
      const filePromises = dirFiles.map(async (file) => {
        const filePath = resolveTargetFilePath(dir, file.path);
        await writeTextFile(filePath, file.content, file.encoding as BufferEncoding || UTF8_ENCODING);
      });
      
      await Promise.all(filePromises);
    });
    
    await Promise.all(savePromises);
    
    if (!silent) {
      logger.info(`Formula '${normalizedConfig.name}@${normalizedConfig.version}' saved to local registry`);
    }
    return { success: true, updatedConfig: normalizedConfig };
  } catch (error) {
    logger.error(`Failed to save formula: ${error}`);
    return { success: false, error: `Failed to save formula: ${error}` };
  }
}


/**
 * Setup the save command
 */
export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .argument('<formula-name>', 'formula name or directory path (/path/to/dir)')
    .argument('[directory]', 'directory path to save from (optional, /path/to/dir)')
    .argument('[version-type]', 'version type: stable (optional)')
    .description('Save a formula to local registry. \n' +
      'Usage patterns:\n' +
      '  g0 save <formula-name> <directory>    # Save MD files from directory to named formula\n' +
      '  g0 save <formula-name>                # Save MD files for existing formula\n' +
      '  g0 save /path/to/dir                  # Save directory as formula (auto-named)\n' +
      'Auto-generates local dev versions by default.')
    .option('-f, --force', 'overwrite existing version or skip confirmations')
    .option('-b, --bump <type>', `bump version (patch|minor|major). Creates prerelease by default, stable when combined with "${VERSION_TYPE_STABLE}" argument`)
    .option('--include <names...>', 'Include formulas into main formula.yml')
    .option('--include-dev <names...>', 'Include dev formulas into main formula.yml')
    .action(withErrorHandling(async (formulaName: string, directory?: string, versionType?: string, options?: SaveOptions) => {
      // Smart argument detection: 'stable' as second argument is treated as version type
      let actualDirectory = directory;
      let actualVersionType = versionType;

      if (directory === 'stable' && !versionType) {
        // Second argument is 'stable' - treat as version type
        actualVersionType = directory;
        actualDirectory = undefined;
      }

      // Validate version type argument
      if (actualVersionType && actualVersionType !== VERSION_TYPE_STABLE) {
        throw new ValidationError(ERROR_MESSAGES.INVALID_VERSION_TYPE.replace('%s', actualVersionType).replace('%s', VERSION_TYPE_STABLE));
      }

      const result = await saveFormulaCommand(formulaName, actualDirectory, actualVersionType, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}

import { join, dirname } from 'path';
import { parseMarkdownFrontmatter } from './formula-yml.js';
import { detectTemplateFile } from './template.js';
import { FILE_PATTERNS, PLATFORMS, PLATFORM_DIRS, PLATFORM_SUBDIRS, FORMULA_DIRS } from '../constants/index.js';
import { getLocalFormulasDir } from './paths.js';
import { logger } from './logger.js';
import {
  exists,
  readTextFile,
  listFiles,
  listDirectories,
  isDirectory
} from './fs.js';
import { calculateFileHash } from './hash-utils.js';
import {
  getDetectedPlatforms,
  getPlatformDefinition,
  getPlatformDirectoryPaths,
  type PlatformName
} from '../core/platforms.js';
import type { DiscoveredFile } from '../types/index.js';

/**
 * Process a single file for discovery - common logic used by multiple discovery methods
 */
async function processFileForDiscovery(
  file: { fullPath: string; relativePath: string },
  formulaName: string,
  platformName: PlatformName,
  registryPathPrefix: string,
  inclusionMode: 'directory' | 'platform',
  formulaDir?: string
): Promise<DiscoveredFile | null> {
  try {
    const content = await readTextFile(file.fullPath);
    let frontmatter;
    try {
      frontmatter = parseMarkdownFrontmatter(content);
    } catch (parseError) {
      logger.warn(`Failed to parse frontmatter in ${file.relativePath}: ${parseError}`);
      frontmatter = null;
    }

    const shouldInclude = inclusionMode === 'directory'
      ? (!frontmatter || !frontmatter.formula || frontmatter?.formula?.name === formulaName || !frontmatter?.formula?.name)
      : shouldIncludeMarkdownFile(file, frontmatter, platformName, formulaName, formulaDir, inclusionMode === 'platform');

    if (shouldInclude) {
      // Skip template files
      if (detectTemplateFile(content)) {
        logger.debug(`Skipping template file: ${file.relativePath}`);
        return null;
      }

      try {
        const mtime = await getFileMtime(file.fullPath);
        const contentHash = await calculateFileHash(content);

        // For platform mode, check if file should be universal (has matching frontmatter)
        // Universal files don't get the platform prefix in their registry path
        let registryPath: string;
        if (inclusionMode === 'platform' && platformName !== ('ai' as PlatformName) && frontmatter?.formula?.name === formulaName) {
          // Universal file from platform directory - map into universal subdir (rules/commands/agents)
          // Compute path relative to the scanned directory (rulesDir/commandsDir/agentsDir)
          const relative = await import('path');
          let relativeFromSourceDir = relative.relative(formulaDir || '', file.fullPath);
          if (relativeFromSourceDir.startsWith('../')) {
            // Safety fallback if traversal occurs unexpectedly
            relativeFromSourceDir = file.relativePath;
          }
          if (relativeFromSourceDir.endsWith(FILE_PATTERNS.MDC_FILES)) {
            relativeFromSourceDir = relativeFromSourceDir.replace(new RegExp(`\\${FILE_PATTERNS.MDC_FILES}$`), FILE_PATTERNS.MD_FILES);
          }
          registryPath = registryPathPrefix ? join(registryPathPrefix, relativeFromSourceDir) : relativeFromSourceDir;
        } else {
          // Platform-specific file or directory mode - use normal registry path logic
          registryPath = registryPathPrefix ? join(registryPathPrefix, file.relativePath) : file.relativePath;
        }

        const result: DiscoveredFile = {
          fullPath: file.fullPath,
          relativePath: file.relativePath,
          sourceDir: platformName,
          registryPath,
          mtime,
          contentHash
        };

        if (frontmatter?.formula?.platformSpecific === true) {
          result.forcePlatformSpecific = true;
        }

        return result;
      } catch (error) {
        logger.warn(`Failed to process file metadata for ${file.relativePath}: ${error}`);
      }
    }
  } catch (error) {
    logger.warn(`Failed to read ${file.relativePath}: ${error}`);
  }
  return null;
}

/**
 * Check if a path matches a platform pattern and extract platform info
 */
function checkPlatformMatch(normalizedPath: string, platform: PlatformName, platformDir: string): { platform: string; relativePath: string; platformName: PlatformName } | null {
  // Check for absolute paths
  const absPlatformPattern = `/${platformDir}/`;
  let platformIndex = normalizedPath.indexOf(absPlatformPattern);
  let isAbsolute = true;

  if (platformIndex === -1) {
    // Check for relative paths
    const relPlatformPattern = `${platformDir}/`;
    platformIndex = normalizedPath.indexOf(relPlatformPattern);
    isAbsolute = false;
  }

  if (platformIndex !== -1) {
    const patternLength = isAbsolute ? absPlatformPattern.length - 1 : `${platformDir}/`.length - 1;
    const relativePath = normalizedPath.substring(platformIndex + patternLength);
    return { platform, relativePath: relativePath.startsWith('/') ? relativePath.substring(1) : relativePath, platformName: platform };
  }

  // Check for exact platform directory matches
  if (normalizedPath === `/${platformDir}` || normalizedPath === platformDir || normalizedPath.endsWith(`/${platformDir}`)) {
    return { platform, relativePath: '', platformName: platform };
  }

  return null;
}

/**
 * Parse a directory path to determine if it's a platform-specific directory
 */
function parsePlatformDirectory(directoryPath: string): { platform: string; relativePath: string; platformName: PlatformName } | null {
  const normalizedPath = directoryPath.replace(/\\/g, '/'); // Normalize for cross-platform

  // Check for AI directory first (special case)
  const aiMatch = checkPlatformMatch(normalizedPath, PLATFORM_DIRS.AI as PlatformName, PLATFORM_DIRS.AI);
  if (aiMatch) {
    return aiMatch;
  }

  // Check for other platforms
  const platforms = Object.values(PLATFORMS) as PlatformName[];
  for (const platform of platforms) {
    if (platform === (PLATFORM_DIRS.AI as PlatformName)) continue; // Already handled above

    // Map platform name to platform directory using the correct key format
    const platformKey = platform.toUpperCase() as keyof typeof PLATFORM_DIRS;
    const platformDir = PLATFORM_DIRS[platformKey];
    const match = checkPlatformMatch(normalizedPath, platform, platformDir);
    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Build platform-based search configuration for file discovery
 */
export async function buildPlatformSearchConfig(cwd: string): Promise<PlatformSearchConfig[]> {
  const detectedPlatforms = await getDetectedPlatforms(cwd);
  const config: PlatformSearchConfig[] = [];

  // Add AI directory as required feature
  config.push({
    name: PLATFORM_DIRS.AI,
    platform: PLATFORM_DIRS.AI as PlatformName, // Special case for AI directory
    rootDir: PLATFORM_DIRS.AI,
    rulesDir: join(cwd, PLATFORM_DIRS.AI),
    filePatterns: [FILE_PATTERNS.MD_FILES],
    registryPath: '' // Empty for AI directory to avoid double ai/ prefix
  });

  // Add detected platform configurations
  for (const platform of detectedPlatforms) {
    const definition = getPlatformDefinition(platform);
    const paths = getPlatformDirectoryPaths(cwd);
    const platformPaths = paths[platform];

    config.push({
      name: platform,
      platform,
      rootDir: definition.rootDir,
      rulesDir: platformPaths.rulesDir,
      commandsDir: platformPaths.commandsDir,
      agentsDir: platformPaths.agentsDir,
      filePatterns: [...definition.filePatterns],
      registryPath: '' // Use empty registry path for universal storage
    });
  }

  return config;
}

// Platform search configuration interface
interface PlatformSearchConfig {
  name: string;
  platform: PlatformName;
  rootDir: string;
  rulesDir: string;
  commandsDir?: string;
  agentsDir?: string;
  filePatterns: string[];
  registryPath: string;
}

/**
 * Recursively find files by extension in a directory
 */
export async function findFilesByExtension(
  dir: string,
  extension: string,
  baseDir: string = dir
): Promise<Array<{ fullPath: string; relativePath: string }>> {
  if (!(await exists(dir)) || !(await isDirectory(dir))) {
    return [];
  }

  const files: Array<{ fullPath: string; relativePath: string }> = [];

  // Check current directory files
  const dirFiles = await listFiles(dir);
  for (const file of dirFiles) {
    if (file.endsWith(extension)) {
      const fullPath = join(dir, file);
      const relativePath = fullPath.substring(baseDir.length + 1);
      files.push({ fullPath, relativePath });
    }
  }

  // Recursively search subdirectories
  const subdirs = await listDirectories(dir);
  const subFilesPromises = subdirs.map(subdir =>
    findFilesByExtension(join(dir, subdir), extension, baseDir)
  );
  const subFiles = await Promise.all(subFilesPromises);
  files.push(...subFiles.flat());

  return files;
}


/**
 * Get file modification time
 * @throws Error if unable to get file stats
 */
async function getFileMtime(filePath: string): Promise<number> {
  const { getStats } = await import('./fs.js');
  const stats = await getStats(filePath);
  return stats.mtime.getTime();
}

/**
 * Process platform subdirectories (rules/commands/agents) within a base directory
 * Common logic shared between different discovery methods
 */
async function processPlatformSubdirectories(
  baseDir: string,
  formulaName: string,
  platformName: PlatformName,
  filePatterns: string[],
  formulaDir?: string
): Promise<DiscoveredFile[]> {
  const allFiles: DiscoveredFile[] = [];
  const subdirs = [
    { name: PLATFORM_SUBDIRS.RULES, path: join(baseDir, PLATFORM_SUBDIRS.RULES) },
    { name: PLATFORM_SUBDIRS.COMMANDS, path: join(baseDir, PLATFORM_SUBDIRS.COMMANDS) },
    { name: PLATFORM_SUBDIRS.AGENTS, path: join(baseDir, PLATFORM_SUBDIRS.AGENTS) }
  ];

  for (const subdir of subdirs) {
    if (await exists(subdir.path) && await isDirectory(subdir.path)) {
      const files = await discoverFiles(
        subdir.path,
        formulaName,
        platformName,
        subdir.name, // Universal registry path
        filePatterns,
        'platform',
        formulaDir
      );
      allFiles.push(...files);
    }
  }

  return allFiles;
}

/**
 * Discover platform subdirectories (rules/commands/agents) within a specific source directory
 * This searches for universal subdirectory names regardless of platform context
 */
export async function discoverPlatformSubdirsInDirectory(
  sourceDir: string,
  formulaName: string,
  platformName: PlatformName
): Promise<DiscoveredFile[]> {
  const platformDefinition = getPlatformDefinition(platformName);
  return processPlatformSubdirectories(sourceDir, formulaName, platformName, [...platformDefinition.filePatterns]);
}

/**
 * Discover md files directly in a directory (shallow search - only immediate directory, not subdirectories)
 */
export async function discoverFilesShallow(
  directoryPath: string,
  formulaName: string,
  platformName: PlatformName,
  registryPathPrefix: string = '',
  filePatterns: string[] = [FILE_PATTERNS.MD_FILES],
  inclusionMode: 'directory' | 'platform' = 'directory'
): Promise<DiscoveredFile[]> {
  return discoverFiles(directoryPath, formulaName, platformName, registryPathPrefix, filePatterns, inclusionMode, undefined, false);
}

/**
 * Discover md files directly in a specified directory (not in platform subdirectories)
 */
export async function discoverDirectMdFiles(
  directoryPath: string,
  formulaName: string,
  platformInfo?: { platform: string; relativePath: string; platformName: PlatformName } | null
): Promise<DiscoveredFile[]> {
  if (!platformInfo) {
    // Non-platform directory - search for .md files directly
    return discoverFiles(directoryPath, formulaName, 'ai' as PlatformName, '', [FILE_PATTERNS.MD_FILES], 'directory');
  } else {
    // Platform-specific directory - search for .md files directly (shallow) and map to universal subdirs
    const definition = getPlatformDefinition(platformInfo.platformName);
    const filePatterns = platformInfo.platformName === (PLATFORM_DIRS.AI as PlatformName)
      ? [FILE_PATTERNS.MD_FILES]
      : [...getPlatformDefinition(platformInfo.platformName).filePatterns];

    // Determine which universal subdir this directory is under (rules/commands/agents)
    const relativeFromPlatformRoot = platformInfo.relativePath || '';
    const rulesSubdirName = definition.rulesDir ? definition.rulesDir.split('/').pop() : undefined;
    const commandsSubdirName = definition.commandsDir ? definition.commandsDir.split('/').pop() : undefined;
    const agentsSubdirName = definition.agentsDir ? definition.agentsDir.split('/').pop() : undefined;

    let universalSubdir: string | undefined;
    let remainderWithinSubdir = '';

    if (rulesSubdirName && (relativeFromPlatformRoot === rulesSubdirName || relativeFromPlatformRoot.startsWith(`${rulesSubdirName}/`))) {
      universalSubdir = PLATFORM_SUBDIRS.RULES;
      remainderWithinSubdir = relativeFromPlatformRoot.substring(rulesSubdirName.length);
    } else if (commandsSubdirName && (relativeFromPlatformRoot === commandsSubdirName || relativeFromPlatformRoot.startsWith(`${commandsSubdirName}/`))) {
      universalSubdir = PLATFORM_SUBDIRS.COMMANDS;
      remainderWithinSubdir = relativeFromPlatformRoot.substring(commandsSubdirName.length);
    } else if (agentsSubdirName && (relativeFromPlatformRoot === agentsSubdirName || relativeFromPlatformRoot.startsWith(`${agentsSubdirName}/`))) {
      universalSubdir = PLATFORM_SUBDIRS.AGENTS;
      remainderWithinSubdir = relativeFromPlatformRoot.substring(agentsSubdirName.length);
    }

    // Build registry prefix: prefer universal subdir mapping (rules/commands/agents). Fallback to platform path if unknown.
    let registryPathPrefix: string;
    if (universalSubdir) {
      const cleanedRemainder = remainderWithinSubdir.replace(/^\//, '');
      registryPathPrefix = cleanedRemainder ? join(universalSubdir, cleanedRemainder) : universalSubdir;
    } else {
      // Fallback: keep platform path structure
      registryPathPrefix = relativeFromPlatformRoot ? join(platformInfo.platform, relativeFromPlatformRoot) : platformInfo.platform;
    }

    return discoverFilesShallow(directoryPath, formulaName, platformInfo.platformName, registryPathPrefix, filePatterns, 'directory');
  }
}

/**
 * Discover files based on the input pattern (explicit directory, directory mode, or formula name)
 * @param formulaDir - Path to the formula directory
 * @param formulaName - Name of the formula
 * @param isExplicitPair - Whether this is an explicit name + directory pair
 * @param isDirectory - Whether input was a directory path
 * @param directoryPath - The directory path if provided
 * @param sourceDir - The resolved source directory to search in
 * @returns Promise resolving to array of discovered files
 */
export async function discoverFilesForPattern(
  formulaDir: string,
  formulaName: string,
  isExplicitPair: boolean,
  isDirectory: boolean,
  directoryPath: string | undefined,
  sourceDir: string
): Promise<DiscoveredFile[]> {
  if ((isExplicitPair || isDirectory) && directoryPath) {
    // Patterns 1 & 2: Directory-based input
    const results: DiscoveredFile[] = [];
    const platformInfo = parsePlatformDirectory(directoryPath);

    if (platformInfo) {
      // Directory is platform-specific - search for direct md files in the specified directory only
      // Don't search for platform subdirectories within the source directory since we already have the explicit path
      const directFiles = await discoverDirectMdFiles(sourceDir, formulaName, platformInfo);
      results.push(...directFiles);

      // Explicitly exclude any accidental ai/ mappings when using a platform-specific directory
      const filteredResults = results.filter((f) => !(f.registryPath === PLATFORM_DIRS.AI || f.registryPath.startsWith(`${PLATFORM_DIRS.AI}/`)));

      // When both formula-name and directory are specified (isExplicitPair), also search globally for frontmatter matches
      if (isExplicitPair) {
        const globalFiles = await discoverMdFilesUnified(formulaDir, formulaName);
        filteredResults.push(...globalFiles);
        return dedupeDiscoveredFilesPreferUniversal(filteredResults);
      }

      return filteredResults;
    } else {
      // Directory is not platform-specific - search for platform subdirectories from cwd + direct files
      const platformSubdirFiles = await discoverMdFilesUnified(formulaDir, formulaName, undefined, true);
      results.push(...platformSubdirFiles);

      // Also search for direct files in the specified directory
      const directFiles = await discoverDirectMdFiles(sourceDir, formulaName, null);
      results.push(...directFiles);

      // When both formula-name and directory are specified (isExplicitPair), also search globally for additional frontmatter matches
      if (isExplicitPair) {
        const globalFiles = await discoverMdFilesUnified(formulaDir, formulaName);
        results.push(...globalFiles);
        return dedupeDiscoveredFilesPreferUniversal(results);
      }
    }

    return results;
  } else {
    // Pattern 3: Legacy formula name input - use unified discovery from formula directory
    return discoverMdFilesUnified(formulaDir, formulaName);
  }
}

/**
 * Discover markdown files in a directory with specified patterns and inclusion rules
 */
export async function discoverFiles(
  directoryPath: string,
  formulaName: string,
  platformName: PlatformName,
  registryPathPrefix: string = '',
  filePatterns: string[] = [FILE_PATTERNS.MD_FILES],
  inclusionMode: 'directory' | 'platform' = 'directory',
  formulaDir?: string,
  recursive: boolean = true
): Promise<DiscoveredFile[]> {
  if (!(await exists(directoryPath)) || !(await isDirectory(directoryPath))) {
    return [];
  }

  // Find files with the specified patterns
  const allFiles: Array<{ fullPath: string; relativePath: string }> = [];

  if (recursive) {
    // Recursive search using findFilesByExtension
    for (const pattern of filePatterns) {
      const extension = pattern.startsWith('.') ? pattern : `.${pattern}`;
      const files = await findFilesByExtension(directoryPath, extension, directoryPath);
      allFiles.push(...files);
    }
  } else {
    // Shallow search - only immediate directory files
    const dirFiles = await listFiles(directoryPath);
    for (const file of dirFiles) {
      // Skip directories - we only want immediate files
      const filePath = join(directoryPath, file);
      if (await isDirectory(filePath)) {
        continue;
      }

      // Check if file matches patterns
      let matchesPattern = false;
      for (const pattern of filePatterns) {
        const extension = pattern.startsWith('.') ? pattern : `.${pattern}`;
        if (file.endsWith(extension)) {
          matchesPattern = true;
          break;
        }
      }

      if (matchesPattern) {
        const fullPath = filePath;
        const relativePath = file; // since we're only in the immediate directory
        allFiles.push({ fullPath, relativePath });
      }
    }
  }

  // Process files in parallel using the extracted helper
  const processPromises = allFiles.map(async (file) =>
    processFileForDiscovery(file, formulaName, platformName, registryPathPrefix, inclusionMode, formulaDir)
  );

  const results = await Promise.all(processPromises);
  return results.filter((result): result is DiscoveredFile => result !== null);
}


/**
 * Unified file discovery function that searches platform-specific directories
 */
export async function discoverMdFilesUnified(formulaDir: string, formulaName: string, baseDir?: string, isDirectoryMode?: boolean): Promise<DiscoveredFile[]> {
  const cwd = baseDir || process.cwd();
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  const allDiscoveredFiles: DiscoveredFile[] = [];

  // Process all platform configurations in parallel
  const processPromises = platformConfigs.map(async (config) => {
    return processPlatformFiles(config, formulaDir, formulaName, isDirectoryMode);
  });

  const results = await Promise.all(processPromises);
  allDiscoveredFiles.push(...results.flat());

  return allDiscoveredFiles;
}

/**
 * Process files for a specific platform configuration
 */
async function processPlatformFiles(
  config: PlatformSearchConfig,
  formulaDir: string,
  formulaName: string,
  isDirectoryMode?: boolean
): Promise<DiscoveredFile[]> {
  // Handle AI directory separately - it's not a platform subdirectory structure
  if (config.name === PLATFORM_DIRS.AI) {
    return discoverFiles(
      config.rulesDir,
      formulaName,
      config.platform,
      PLATFORM_DIRS.AI, // AI directory uses 'ai' prefix
      config.filePatterns,
      'platform',
      formulaDir
    );
  }

  // Process platform subdirectories with universal registry paths
  const allFiles: DiscoveredFile[] = [];
  const subdirs = [
    { dir: config.rulesDir, registryPath: PLATFORM_SUBDIRS.RULES },
    { dir: config.commandsDir, registryPath: PLATFORM_SUBDIRS.COMMANDS },
    { dir: config.agentsDir, registryPath: PLATFORM_SUBDIRS.AGENTS }
  ];

  for (const subdir of subdirs) {
    if (subdir.dir && await exists(subdir.dir) && await isDirectory(subdir.dir)) {
      const files = await discoverFiles(
        subdir.dir,
        formulaName,
        config.platform,
        subdir.registryPath, // Universal registry path
        config.filePatterns,
        'platform',
        formulaDir
      );
      allFiles.push(...files);
    }
  }

  return allFiles;
}

/**
 * Determine if a markdown file should be included based on frontmatter rules
 */
function shouldIncludeMarkdownFile(
  mdFile: { relativePath: string },
  frontmatter: any,
  sourceDir: string,
  formulaName: string,
  formulaDirRelativeToAi?: string,
  isDirectoryMode?: boolean
): boolean {
  const mdFileDir = dirname(mdFile.relativePath);

  // For AI directory: include files adjacent to formula.yml or with matching frontmatter
  if (sourceDir === PLATFORM_DIRS.AI) {
    if (frontmatter?.formula?.name === formulaName) {
      logger.debug(`Including ${mdFile.relativePath} from ai (matches formula name in frontmatter)`);
      return true;
    }

    // For directory mode, skip the "adjacent to formula.yml" check since there's no formula.yml in source
    if (!isDirectoryMode && mdFileDir === formulaDirRelativeToAi && (!frontmatter || !frontmatter.formula)) {
      logger.debug(`Including ${mdFile.relativePath} from ai (adjacent to formula.yml, no conflicting frontmatter)`);
      return true;
    }

    // For directory mode, include files without conflicting frontmatter
    if (isDirectoryMode && (!frontmatter || !frontmatter.formula || frontmatter.formula.name === formulaName)) {
      logger.debug(`Including ${mdFile.relativePath} from ai (directory mode, no conflicting frontmatter)`);
      return true;
    }

    if (frontmatter?.formula?.name && frontmatter.formula.name !== formulaName) {
      logger.debug(`Skipping ${mdFile.relativePath} from ai (frontmatter specifies different formula: ${frontmatter.formula.name})`);
    } else {
      logger.debug(`Skipping ${mdFile.relativePath} from ai (not adjacent to formula.yml and no matching frontmatter)`);
    }
    return false;
  }

  // For command directories: only include files with matching frontmatter
  if (frontmatter?.formula?.name === formulaName) {
    logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (matches formula name in frontmatter)`);
    return true;
  }

  // For directory mode in platform directories, include files without conflicting frontmatter
  if (isDirectoryMode && (!frontmatter || !frontmatter.formula || frontmatter.formula.name === formulaName)) {
    logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (directory mode, no conflicting frontmatter)`);
    return true;
  }

  logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDir} (no matching frontmatter)`);
  return false;
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
          const { parseFormulaYml } = await import('./formula-yml.js');
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

    // Check rules directory
    if (config.rulesDir) {
      await processMarkdownFiles(config.rulesDir, config.registryPath, config.name);
    }

    // Check commands directory
    if (config.commandsDir) {
      await processMarkdownFiles(
        config.commandsDir,
        join(config.registryPath, PLATFORM_SUBDIRS.COMMANDS),
        config.name
      );
    }

    // Check agents directory
    if (config.agentsDir) {
      await processMarkdownFiles(
        config.agentsDir,
        join(config.registryPath, PLATFORM_SUBDIRS.AGENTS),
        config.name
      );
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


/**
 * Dedupe discovered files by source fullPath, preferring universal subdirs over ai
 */
export function dedupeDiscoveredFilesPreferUniversal(files: DiscoveredFile[]): DiscoveredFile[] {
  const preference = (registryPath: string): number => {
    if (registryPath.startsWith(`${PLATFORM_SUBDIRS.RULES}/`) || registryPath === PLATFORM_SUBDIRS.RULES) return 3;
    if (registryPath.startsWith(`${PLATFORM_SUBDIRS.COMMANDS}/`) || registryPath === PLATFORM_SUBDIRS.COMMANDS) return 3;
    if (registryPath.startsWith(`${PLATFORM_SUBDIRS.AGENTS}/`) || registryPath === PLATFORM_SUBDIRS.AGENTS) return 3;
    if (registryPath.startsWith(`${PLATFORM_DIRS.AI}/`) || registryPath === PLATFORM_DIRS.AI) return 2;
    return 1;
  };

  const map = new Map<string, DiscoveredFile>();
  for (const file of files) {
    const existing = map.get(file.fullPath);
    if (!existing) {
      map.set(file.fullPath, file);
      continue;
    }
    if (preference(file.registryPath) > preference(existing.registryPath)) {
      map.set(file.fullPath, file);
    }
  }
  return Array.from(map.values());
}

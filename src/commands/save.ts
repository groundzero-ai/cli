import { Command } from 'commander';
import { join, basename } from 'path';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml, updateMarkdownWithFormulaFrontmatter } from '../utils/formula-yml.js';
import { detectTemplateFile } from '../utils/template.js';
import { ensureRegistryDirectories, getFormulaVersionPath, hasFormulaVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { getLocalFormulaDir } from '../utils/paths.js';
import { ensureLocalGroundZeroStructure, createBasicFormulaYml, addFormulaToYml } from '../utils/formula-management.js';
import { FILE_PATTERNS } from '../constants/index.js';

import { generateLocalVersion, isLocalVersion, extractBaseVersion } from '../utils/version-generator.js';
import { promptConfirmation } from '../utils/prompts.js';
import { getTargetDirectory, getTargetFilePath } from '../utils/platform-utils.js';
import { resolveFileConflicts } from '../utils/conflict-resolution.js';
import { discoverFilesForPattern } from '../utils/file-discovery.js';
import type { DiscoveredFile } from '../types/index.js';
import { exists, readTextFile, writeTextFile, ensureDir } from '../utils/fs.js';
import { postSavePlatformSync } from '../utils/platform-sync.js';

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
  NAME: '📦 Name:',
  VERSION: '📦 Version:',
  FILES: '📄 Found',
  FILES_SUFFIX: 'markdown files',
  RESOLVED: '📄 Conflicts resolved, processed',
  SAVED: '✅ Saved',
  UPDATED: '✓ Updated frontmatter in',
  EXPLICIT_VERSION: '🎯 Using explicit version:',
  PRERELEASE: '🎯 No version found, setting to prerelease:',
  BUMP_STABLE: '🎯 Bumping to stable version:',
  BUMP_PRERELEASE: '🎯 Bumping to prerelease version:',
  CONVERT_STABLE: '🎯 Converting to stable version:',
  OVERWRITE_STABLE: '🎯 Overwriting stable version:',
  INCREMENT_PRERELEASE: '🎯 Incrementing prerelease version:',
  AUTO_INCREMENT: '🎯 Auto-incrementing to patch prerelease:',
  WARNING: '⚠️  Version',
  WARNING_SUFFIX: 'is already stable.',
  ARROW_SEPARATOR: ' → '
} as const;

/**
 * Parse formula inputs to handle three usage patterns:
 * 1. Explicit name + directory: formula-name /path/to/dir
 * 2. Directory only (legacy): /path/to/dir
 * 3. Formula name only (legacy): formula-name or formula-name@version
 */
function parseFormulaInputs(formulaName: string, directory?: string): {
  name: string;
  version?: string;
  isDirectory: boolean;
  directoryPath?: string;
  isExplicitPair: boolean;
} {
  // Pattern 1: Explicit name + directory (new functionality)
  if (directory) {
    return {
      name: formulaName,
      isDirectory: true,
      directoryPath: directory,
      isExplicitPair: true
    };
  }

  // Pattern 2: Directory path as first argument (legacy)
  if (formulaName.startsWith('/')) {
    const directoryPath = formulaName;
    const name = basename(directoryPath);

    if (!name) {
      throw new ValidationError(`Invalid directory path: ${formulaName}`);
    }

    return {
      name,
      isDirectory: true,
      directoryPath,
      isExplicitPair: false
    };
  }

  // Pattern 3: Formula name with optional version (legacy)
  const atIndex = formulaName.lastIndexOf('@');

  if (atIndex === -1) {
    return {
      name: formulaName,
      isDirectory: false,
      isExplicitPair: false
    };
  }

  const name = formulaName.substring(0, atIndex);
  const version = formulaName.substring(atIndex + 1);

  if (!name || !version) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_FORMULA_SYNTAX.replace('%s', formulaName));
  }

  return {
    name,
    version,
    isDirectory: false,
    isExplicitPair: false
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
    name: formulaName,
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
 * @param formulaDir - Directory where formula.yml should be located
 * @param formulaName - Name of the formula
 * @returns Formula configuration info
 */
async function getOrCreateFormulaConfig(formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean }> {
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    logger.debug('Found existing formula.yml, parsing...');
    try {
      const formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(LOG_PREFIXES.FOUND);
      console.log(`${LOG_PREFIXES.NAME} ${formulaConfig.name}`);
      console.log(`${LOG_PREFIXES.VERSION} ${formulaConfig.version}`);

      return {
        fullPath: formulaYmlPath,
        config: formulaConfig,
        isNewFormula: false
      };
    } catch (error) {
      throw new ValidationError(ERROR_MESSAGES.PARSE_FORMULA_FAILED.replace('%s', formulaYmlPath).replace('%s', String(error)));
    }
  } else {
    logger.debug('No formula.yml found, creating automatically...');
    return await createFormulaYmlInDirectory(formulaDir, formulaName);
  }
}


/**
 * Resolve the source directory based on input pattern and directory path
 * @param directoryPath - The directory path to resolve
 * @param isExplicitPair - Whether this is an explicit name + directory pair
 * @param isDirectory - Whether input was a directory path
 * @returns Promise resolving to the resolved source directory path
 * @throws ValidationError if directory path is required but not provided
 */
async function resolveSourceDirectory(directoryPath: string | undefined, isExplicitPair: boolean, isDirectory: boolean): Promise<string> {
  if (!directoryPath) {
    throw new ValidationError('Directory path is required');
  }

  if (directoryPath.startsWith('/')) {
    const absolutePath = directoryPath;
    const relativePath = join(process.cwd(), directoryPath.substring(1));
    // Use the path that exists, prefer absolute
    if (await exists(absolutePath)) {
      return absolutePath;
    } else if (await exists(relativePath)) {
      return relativePath;
    } else {
      return absolutePath; // Default to absolute
    }
  } else {
    return join(process.cwd(), directoryPath);
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
  console.log(`${LOG_PREFIXES.FILES} ${discoveredFiles.length} ${LOG_PREFIXES.FILES_SUFFIX}`);

  // Resolve file conflicts (keep latest mtime)
  const resolvedFiles = await resolveFileConflicts(discoveredFiles, formulaConfig.version);
  if (resolvedFiles.length !== discoveredFiles.length) {
    console.log(`${LOG_PREFIXES.RESOLVED} ${resolvedFiles.length} files`);
  }

  // Create formula files array
  return await createFormulaFilesUnified(formulaYmlPath, formulaConfig, resolvedFiles);
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

  // Parse inputs to determine the pattern being used
  const { name, version: explicitVersion, isDirectory, directoryPath, isExplicitPair } = parseFormulaInputs(formulaName, directory);

  logger.debug(`Saving formula with name: ${name}`, { explicitVersion, isDirectory, directoryPath, isExplicitPair, options });

  // Initialize formula environment
  await ensureRegistryDirectories();
  await createBasicFormulaYml(cwd);

  // Get formula configuration based on input pattern
  const formulaDir = getLocalFormulaDir(cwd, name);
  const formulaInfo = await getOrCreateFormulaConfig(formulaDir, name);
  const formulaYmlPath = formulaInfo.fullPath;
  let formulaConfig = formulaInfo.config;

  logger.debug(`Found formula.yml at: ${formulaYmlPath}`);

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

  // Determine source directory for file discovery
  const sourceDir = (isExplicitPair || isDirectory) && directoryPath
    ? await resolveSourceDirectory(directoryPath, isExplicitPair, isDirectory)
    : formulaDir;

  // Discover and include MD files using appropriate logic
  let discoveredFiles = await discoverFilesForPattern(formulaDir, formulaConfig.name, isExplicitPair, isDirectory, directoryPath, sourceDir);

  // Process discovered files and create formula files array
  const formulaFiles = await processDiscoveredFiles(formulaYmlPath, formulaConfig, discoveredFiles);

  // Save formula to local registry
  const saveResult = await saveFormulaToRegistry(formulaConfig, formulaFiles, formulaYmlPath, options?.force);

  if (!saveResult.success) {
    return { success: false, error: saveResult.error || ERROR_MESSAGES.SAVE_FAILED };
  }

  // Sync files across detected platforms
  const syncResult = await postSavePlatformSync(cwd, formulaFiles);

  // Finalize the save operation
  await addFormulaToYml(cwd, formulaConfig.name, formulaConfig.version);
  console.log(`${LOG_PREFIXES.SAVED} ${formulaConfig.name}@${formulaConfig.version} (${formulaFiles.length} files)`);

  // Display platform sync results
  if (syncResult.created.length > 0) {
    console.log(`🔄 Platform sync created ${syncResult.created.length} files:`);
    for (const createdFile of syncResult.created) {
      console.log(`   ├── ${createdFile}`);
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
    isTemplate: false,
    encoding: UTF8_ENCODING
  };
}

/**
 * Process discovered markdown files and return formula file entries
 */
async function processMarkdownFiles(formulaConfig: FormulaYml, discoveredFiles: DiscoveredFile[]): Promise<FormulaFile[]> {
  // Process discovered MD files in parallel
  const mdFilePromises = discoveredFiles.map(async (mdFile) => {
    const originalContent = await readTextFile(mdFile.fullPath);
    const updatedContent = updateMarkdownWithFormulaFrontmatter(originalContent, formulaConfig.name);

    // Update source file if content changed
    if (updatedContent !== originalContent) {
      await writeTextFile(mdFile.fullPath, updatedContent);
      console.log(`${LOG_PREFIXES.UPDATED} ${mdFile.relativePath}`);
    }

    return {
      path: mdFile.registryPath,
      content: updatedContent,
      isTemplate: detectTemplateFile(updatedContent),
      encoding: UTF8_ENCODING
    };
  });

  return await Promise.all(mdFilePromises);
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
      // Already stable - prompt for confirmation
      console.log(`${LOG_PREFIXES.WARNING} ${currentVersion} ${LOG_PREFIXES.WARNING_SUFFIX}`);
      if (!options?.force) {
        const shouldOverwrite = await promptConfirmation(
          `Overwrite existing stable version ${currentVersion}?`,
          false
        );
        if (!shouldOverwrite) {
          throw new Error(ERROR_MESSAGES.OPERATION_CANCELLED);
        }
      }
      console.log(`${LOG_PREFIXES.OVERWRITE_STABLE} ${currentVersion}`);
      return currentVersion;
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
  force?: boolean
): Promise<{ success: boolean; error?: string; updatedConfig?: FormulaYml }> {
  try {
    const targetPath = getFormulaVersionPath(config.name, config.version);
    await ensureDir(targetPath);
    
    // Group files by target directory
    const directoryGroups = new Map<string, FormulaFile[]>();
    
    for (const file of files) {
      const targetDir = getTargetDirectory(targetPath, file.path);
      if (!directoryGroups.has(targetDir)) {
        directoryGroups.set(targetDir, []);
      }
      directoryGroups.get(targetDir)!.push(file);
    }
    
    // Save files in parallel by directory
    const savePromises = Array.from(directoryGroups.entries()).map(async ([dir, dirFiles]) => {
      await ensureDir(dir);
      
      const filePromises = dirFiles.map(async (file) => {
        const filePath = getTargetFilePath(dir, file.path);
        await writeTextFile(filePath, file.content, file.encoding as BufferEncoding || UTF8_ENCODING);
      });
      
      await Promise.all(filePromises);
    });
    
    await Promise.all(savePromises);
    
    logger.info(`Formula '${config.name}@${config.version}' saved to local registry`);
    return { success: true, updatedConfig: config };
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

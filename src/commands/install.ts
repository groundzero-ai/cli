import { Command } from 'commander';
import { join, dirname } from 'path';
import * as semver from 'semver';
import { InstallOptions, CommandResult, FormulaYml, FormulaDependency, Formula } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { checkExistingFormulaInMarkdownFiles } from '../core/groundzero.js';
import { resolveDependencies, displayDependencyTree, ResolvedFormula } from '../core/dependency-resolver.js';
import { promptFormulaInstallConflict } from '../utils/prompts.js';
import { writeTextFile, exists, ensureDir } from '../utils/fs.js';
import { CURSOR_TEMPLATES, GENERAL_TEMPLATES } from '../utils/embedded-templates.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import {
  parseVersionRange,
} from '../utils/version-ranges.js';
import {
  PLATFORM_DIRS,
  PLATFORMS,
  FILE_PATTERNS,
  PLATFORM_SUBDIRS,
  DEPENDENCY_ARRAYS,
  CONFLICT_RESOLUTION,
  GROUNDZERO_DIRS
} from '../constants/index.js';
import {
  getPlatformDirectoryPaths,
  createPlatformDirectories,
  getPlatformDefinition,
  type PlatformName
} from '../core/platforms.js';
import {
  getLocalFormulaYmlPath,
  getLocalGroundZeroDir,
  getLocalFormulasDir,
  getAIDir
} from '../utils/paths.js';
import { createBasicFormulaYml, addFormulaToYml } from '../utils/formula-management.js';
import {
  parseFormulaInput,
  detectPlatforms,
  promptForPlatformSelection,
  displayInstallationSummary,
  displayInstallationResults
} from '../utils/formula-installation.js';
import {
  withFileOperationErrorHandling,
  withOperationErrorHandling,
  handleUserCancellation
} from '../utils/error-handling.js';


/**
 * Copy registry formula.yml to local project structure
 * @param cwd - Current working directory
 * @param formulaName - Name of the formula to copy
 * @param registryFormula - Formula object from registry containing metadata
 */
async function copyRegistryFormulaYml(
  cwd: string,
  formulaName: string,
  registryFormula: Formula
): Promise<void> {
  const localFormulaDir = join(getLocalFormulasDir(cwd), formulaName);
  const localFormulaYmlPath = join(localFormulaDir, FILE_PATTERNS.FORMULA_YML);
  
  await ensureDir(localFormulaDir);
  await writeFormulaYml(localFormulaYmlPath, registryFormula.metadata);
  
  logger.debug(`Copied registry formula.yml for ${formulaName} to local project`);
}




/**
 * Create platform directories for detected or selected platforms
 * @param targetDir - Target directory to create platform directories in
 * @param platforms - Array of platform names to create directories for
 * @returns Array of created directory paths
 */
async function createPlatformDirectoriesForInstall(
  targetDir: string,
  platforms: string[]
): Promise<string[]> {
  return await createPlatformDirectories(targetDir, platforms as PlatformName[]);
}

/**
 * Add groundzero.md file to each platform's rulesDir
 * Uses platform definitions to determine correct file locations
 * @param targetDir - Target directory where platform directories exist
 * @param platforms - Array of platform names to add template files for
 * @param options - Installation options including force flag
 * @returns Object containing arrays of added files, skipped files, and created directories
 */
async function provideIdeTemplateFiles(
  targetDir: string,
  platforms: string[],
  options: InstallOptions
): Promise<{ filesAdded: string[]; skipped: string[]; directoriesCreated: string[] }> {
  const provided = { 
    filesAdded: [] as string[], 
    skipped: [] as string[], 
    directoriesCreated: [] as string[] 
  };
  
  // Process platforms in parallel
  const platformPromises = platforms.map(async (platform) => {
    const platformDefinition = getPlatformDefinition(platform as PlatformName);
    const rulesDir = join(targetDir, platformDefinition.rulesDir);
    
    logger.info(`Adding groundzero file to ${platform} rules directory`);
    
    const rulesDirExists = await exists(rulesDir);
    if (!rulesDirExists) {
      provided.directoriesCreated.push(platformDefinition.rulesDir);
    }

    // Create rules directory (ensureDir handles existing directories gracefully)
    await ensureDir(rulesDir);
    
    // Add groundzero file to the platform's rulesDir
    // Cursor uses .mdc files, all other platforms use .md files
    const isCursor = platform === PLATFORMS.CURSOR;
    const fileName = isCursor ? FILE_PATTERNS.GROUNDZERO_MDC : FILE_PATTERNS.GROUNDZERO_MD;
    const groundzeroFile = join(rulesDir, fileName);
    const templateContent = isCursor 
      ? CURSOR_TEMPLATES[FILE_PATTERNS.GROUNDZERO_MDC]
      : GENERAL_TEMPLATES[FILE_PATTERNS.GROUNDZERO_MD];
    
    const fileExists = await exists(groundzeroFile);
    
    if (fileExists && !options.force) {
      provided.skipped.push(`${platformDefinition.rulesDir}/${fileName}`);
      logger.debug(`Skipped existing ${fileName} in ${platform} rules directory`);
    } else {
      await writeTextFile(groundzeroFile, templateContent);
      provided.filesAdded.push(`${platformDefinition.rulesDir}/${fileName}`);
      logger.debug(`Added ${fileName} to ${platform} rules directory: ${groundzeroFile}`);
    }
  });
  
  await Promise.all(platformPromises);
  
  return provided;
}



/**
 * Categorize formula files by installation target
 * Handles all 13 platforms with GROUNDZERO_DIRS (rules, commands, agents) mapping
 */
function categorizeFormulaFiles(files: Array<{ path: string; content: string }>) {
  const categorized: {
    aiFiles: Array<{ path: string; content: string }>;
    platformFiles: Array<{ path: string; content: string; platform: string; platformDir: string }>;
  } = {
    aiFiles: [],
    platformFiles: []
  };
  
  // AI files (files under /ai in the formula from local registry) - same as before
  categorized.aiFiles = files.filter(file => 
    file.path.startsWith('ai/') && (file.path.endsWith(FILE_PATTERNS.MD_FILES) || file.path === `ai/${FILE_PATTERNS.FORMULA_YML}`)
  );
  
  // Platform files - files in universal subdirectories should be installed to all platforms
  // that support that subdirectory type
  for (const file of files) {
    // Skip AI files (already handled above)
    if (file.path.startsWith('ai/')) {
      continue;
    }

    // Check universal subdirectories (rules, commands, agents)
    const universalSubdirs = Object.values(GROUNDZERO_DIRS) as string[];
    for (const subdir of universalSubdirs) {
      if (file.path.startsWith(`${subdir}/`)) {
        // Universal files get installed to all platforms that support this subdirectory
        categorized.platformFiles.push({
          ...file,
          platform: 'universal', // Mark as universal - will be installed to all applicable platforms
          platformDir: subdir
        });
        break;
      }
    }
  }
  
  return categorized;
}

/**
 * Install files of a specific type to target directory
 * @param files - Array of file objects with path and content
 * @param targetBasePath - Base path where files should be installed
 * @param pathPrefix - Prefix to strip from file paths when determining relative paths
 * @param options - Installation options including force flag
 * @param dryRun - If true, only simulate the installation
 * @returns Object containing count of installed files and array of installed file paths
 */
async function installFileType(
  files: Array<{ path: string; content: string }>,
  targetBasePath: string,
  pathPrefix: string,
  options: InstallOptions,
  dryRun: boolean = false
): Promise<{ installedCount: number; files: string[] }> {
  const installedFiles: string[] = [];
  let installedCount = 0;

  if (!dryRun && files.length > 0) {
    // Pre-create all necessary directories to avoid redundant ensureDir calls
    const directories = new Set<string>();
    for (const file of files) {
      const relativePath = file.path.startsWith(pathPrefix) ? file.path.substring(pathPrefix.length) : file.path;
      const targetPath = join(targetBasePath, relativePath);
      directories.add(dirname(targetPath));
    }

    // Create all directories in parallel
    await Promise.all(Array.from(directories).map(dir => ensureDir(dir)));
  }

  for (const file of files) {
    const relativePath = file.path.startsWith(pathPrefix) ? file.path.substring(pathPrefix.length) : file.path;
    const targetPath = join(targetBasePath, relativePath);

    if (!dryRun) {
      const fileExists = await exists(targetPath);

      if (fileExists && !options.force) {
        if (pathPrefix === 'ai/') {
          console.log(`⚠️  File already exists: ${targetPath}`);
          console.log('   Use --force to overwrite existing files.');
        } else {
          logger.debug(`Skipping existing ${pathPrefix.slice(0, -1)} file: ${targetPath}`);
        }
        continue;
      }

      await writeTextFile(targetPath, file.content);
      logger.debug(`Installed ${pathPrefix.slice(0, -1)} file: ${relativePath}`);
    }

    installedFiles.push(pathPrefix === 'ai/' ? relativePath : `${pathPrefix.slice(0, -1)}/${relativePath}`);
    installedCount++;
  }

  return { installedCount, files: installedFiles };
}

/**
 * Install formula files to ai directory
 * @param formulaName - Name of the formula to install
 * @param targetDir - Target directory for installation
 * @param options - Installation options including force and dry-run flags
 * @param version - Specific version to install (optional)
 * @param forceOverwrite - Force overwrite existing files
 * @returns Object containing installation results including file counts and status flags
 */
async function installFormulaToGroundzero(
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  version?: string,
  forceOverwrite?: boolean
): Promise<{ installedCount: number; files: string[]; overwritten: boolean; skipped: boolean }> {
  const cwd = process.cwd();
  const groundzeroPath = getAIDir(cwd);

  // Determine formula groundzero path (for AI files)
  const aiGroundzeroPath = targetDir && targetDir !== '.'
    ? join(groundzeroPath, targetDir.startsWith('/') ? targetDir.slice(1) : targetDir)
    : groundzeroPath;

  await ensureDir(groundzeroPath);

  // Load formula
  const formula = await formulaManager.loadFormula(formulaName, version);

  // Copy registry formula.yml to local project structure
  await copyRegistryFormulaYml(cwd, formulaName, formula);

  // Create modified options with force flag if needed
  const installOptions = forceOverwrite ? { ...options, force: true } : options;

  // Categorize and install files
  const { aiFiles, platformFiles } = categorizeFormulaFiles(formula.files);

  // Install AI files directly to ai/ (not ai/formulaName/)
  const aiResult = await installFileType(aiFiles, aiGroundzeroPath, 'ai/', installOptions, options.dryRun);
  
  // Install platform files to their respective directories
  const platformResults = await Promise.all(
    platformFiles.map(async (file) => {
      if (file.platform === 'universal') {
        // Universal files should be installed to all platforms that support the subdirectory type
        const subdirType = file.platformDir; // 'rules', 'commands', or 'agents'
        const supportedPlatforms = await detectPlatforms(cwd);

        // Install to each supported platform
        const universalResults = await Promise.all(
          supportedPlatforms.map(async (platform) => {
            const platformDefinition = getPlatformDefinition(platform as PlatformName);

            // Check if this platform supports the subdirectory type
            let platformSubdir: string | undefined;
            if (subdirType === GROUNDZERO_DIRS.RULES) {
              platformSubdir = platformDefinition.rulesDir.split('/').pop();
            } else if (subdirType === GROUNDZERO_DIRS.COMMANDS) {
              platformSubdir = platformDefinition.commandsDir?.split('/').pop();
            } else if (subdirType === GROUNDZERO_DIRS.AGENTS) {
              platformSubdir = platformDefinition.agentsDir?.split('/').pop();
            }

            if (!platformSubdir) {
              // Platform doesn't support this subdirectory type
              return { installedCount: 0, files: [] };
            }

            const platformDir = PLATFORM_DIRS[(platform as PlatformName).toUpperCase() as keyof typeof PLATFORM_DIRS];
            const targetDir = join(cwd, platformDir, platformSubdir);

            // Special case: Skip GEMINICLI commands files (they are .toml files, not .md files)
            if (platform === PLATFORMS.GEMINICLI && subdirType === GROUNDZERO_DIRS.COMMANDS && file.path.endsWith('.toml')) {
              logger.debug(`Skipping GEMINICLI .toml commands file: ${file.path}`);
              return { installedCount: 0, files: [] };
            }

            // Use appropriate file pattern for the platform
            const filePattern = platform === PLATFORMS.CURSOR ? FILE_PATTERNS.MDC_FILES : FILE_PATTERNS.MD_FILES;

            // Filter files by platform-specific patterns
            if (!file.path.endsWith(filePattern)) {
              logger.debug(`Skipping file with wrong pattern for platform ${platform}: ${file.path}`);
              return { installedCount: 0, files: [] };
            }

            return await installFileType([file], targetDir, `${subdirType}/`, installOptions, options.dryRun);
          })
        );

        // Combine results from all platforms
        const totalInstalled = universalResults.reduce((sum, result) => sum + result.installedCount, 0);
        const allFiles = universalResults.flatMap(result => result.files);
        return { installedCount: totalInstalled, files: allFiles };
      } else {
        // Legacy platform-specific handling (shouldn't happen with new save format)
        const platform = file.platform as PlatformName;
        const platformDir = file.platformDir;
        const platformDefinition = getPlatformDefinition(platform);

        // Special case: Skip GEMINICLI commands files (they are .toml files, not .md files)
        if (platform === PLATFORMS.GEMINICLI && file.path.includes('/commands/') && file.path.endsWith('.toml')) {
          logger.debug(`Skipping GEMINICLI .toml commands file: ${file.path}`);
          return { installedCount: 0, files: [] };
        }

        // Determine target directory based on GROUNDZERO_DIRS mapping
        let targetDir = join(cwd, platformDir);

        // Map GROUNDZERO_DIRS to platform-specific subdirectories
        if (file.path.includes(`/${GROUNDZERO_DIRS.RULES}/`)) {
          targetDir = join(targetDir, platformDefinition.rulesDir.split('/').pop() || PLATFORM_SUBDIRS.RULES);
        } else if (file.path.includes(`/${GROUNDZERO_DIRS.COMMANDS}/`)) {
          if (platformDefinition.commandsDir) {
            targetDir = join(targetDir, platformDefinition.commandsDir.split('/').pop() || PLATFORM_SUBDIRS.COMMANDS);
          } else {
            // Skip if platform doesn't support commands
            logger.debug(`Skipping commands file for platform ${platform} (not supported): ${file.path}`);
            return { installedCount: 0, files: [] };
          }
        } else if (file.path.includes(`/${GROUNDZERO_DIRS.AGENTS}/`)) {
          if (platformDefinition.agentsDir) {
            targetDir = join(targetDir, platformDefinition.agentsDir.split('/').pop() || PLATFORM_SUBDIRS.AGENTS);
          } else {
            // Skip if platform doesn't support agents
            logger.debug(`Skipping agents file for platform ${platform} (not supported): ${file.path}`);
            return { installedCount: 0, files: [] };
          }
        }

        // Use appropriate file pattern for the platform
        const filePattern = platform === PLATFORMS.CURSOR ? FILE_PATTERNS.MDC_FILES : FILE_PATTERNS.MD_FILES;

        // Filter files by platform-specific patterns
        if (!file.path.endsWith(filePattern)) {
          logger.debug(`Skipping file with wrong pattern for platform ${platform}: ${file.path}`);
          return { installedCount: 0, files: [] };
        }

        return await installFileType([file], targetDir, `${platformDir}/`, installOptions, options.dryRun);
      }
    })
  );
  
  const totalInstalled = aiResult.installedCount + platformResults.reduce((sum, result) => sum + result.installedCount, 0);
  const allFiles = [...aiResult.files, ...platformResults.flatMap(result => result.files)];
  
  return {
    installedCount: totalInstalled,
    files: allFiles,
    overwritten: false,
    skipped: false
  };
}

/**
 * Install main formula files to target directory (non-MD, non-formula.yml files)
 * @param resolved - Resolved formula object containing files to install
 * @param targetDir - Target directory for file installation
 * @param options - Installation options including force flag
 * @returns Object containing count of installed files and array of conflict paths
 */
async function installMainFormulaFiles(
  resolved: ResolvedFormula,
  targetDir: string,
  options: InstallOptions
): Promise<{ installedCount: number; conflicts: string[] }> {
  const { formula } = resolved;
  
  // Filter and prepare installation plan
  const filesToInstall = formula.files.filter(file => 
    file.path !== FILE_PATTERNS.FORMULA_YML && !file.path.endsWith(FILE_PATTERNS.MD_FILES)
  );
  
  if (filesToInstall.length === 0) {
    return { installedCount: 0, conflicts: [] };
  }
  
  // Check for existing files in parallel
  const existenceChecks = await Promise.all(
    filesToInstall.map(async (file) => {
      const targetPath = join(targetDir, file.path);
      const fileExists = await exists(targetPath);
      return { file, targetPath, exists: fileExists };
    })
  );
  
  const conflicts = existenceChecks.filter(item => item.exists);
  
  // Handle conflicts
  if (conflicts.length > 0 && !options.force) {
    console.log(`⚠️  The following files already exist and would be overwritten:`);
    conflicts.forEach(conflict => console.log(`   • ${conflict.targetPath}`));
    console.log('\n   Use --force to overwrite existing files.');
    
    throw new ValidationError('Files would be overwritten - use --force to continue');
  }
  
  // Pre-create all necessary directories to avoid redundant ensureDir calls
  if (existenceChecks.length > 0) {
    const directories = new Set<string>();
    for (const { targetPath } of existenceChecks) {
      directories.add(dirname(targetPath));
    }

    // Create all directories in parallel
    await Promise.all(Array.from(directories).map(dir => ensureDir(dir)));
  }

  // Install files in parallel
  const installPromises = existenceChecks.map(async ({ file, targetPath }) =>
    withFileOperationErrorHandling(
      async () => {
        await writeTextFile(targetPath, file.content);
        logger.debug(`Installed file: ${targetPath}`);
        return true;
      },
      targetPath,
      'install file'
    )
  );

  await Promise.all(installPromises);
  
  return {
    installedCount: filesToInstall.length,
    conflicts: conflicts.map(c => c.targetPath)
  };
}

/**
 * Extract formulas from formula.yml configuration
 */
function extractFormulasFromConfig(config: FormulaYml): Array<{ name: string; isDev: boolean }> {
  const formulas: Array<{ name: string; isDev: boolean }> = [];
  
  // Add production formulas
  config.formulas?.forEach(formula => {
    formulas.push({ name: formula.name, isDev: false });
  });
  
  // Add dev formulas
  config[DEPENDENCY_ARRAYS.DEV_FORMULAS]?.forEach(formula => {
    formulas.push({ name: formula.name, isDev: true });
  });
  
  return formulas;
}


/**
 * Install all formulas from CWD formula.yml file
 * @param targetDir - Target directory for installation
 * @param options - Installation options including dev flag
 * @returns Command result with installation summary
 */
async function installAllFormulasCommand(
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  const cwd = process.cwd();
  logger.info(`Installing all formulas from formula.yml to: ${getAIDir(cwd)}`, { options });
  
  await ensureRegistryDirectories();
  
  // Auto-create basic formula.yml if it doesn't exist
  await createBasicFormulaYml(cwd);
  
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  
  const cwdConfig: FormulaYml = await withOperationErrorHandling(
    () => parseFormulaYml(formulaYmlPath),
    'parse formula.yml',
    formulaYmlPath
  );
  
  const formulasToInstall = extractFormulasFromConfig(cwdConfig);
  
  if (formulasToInstall.length === 0) {
    console.log('📦 No formulas found in formula.yml');
    console.log('\nTips:');
    console.log('• Add formulas to the "formulas" array in formula.yml');
    console.log('• Add development formulas to the "dev-formulas" array in formula.yml');
    console.log('• Use "g0 install <formula-name>" to install a specific formula');
    
    return { success: true, data: { installed: 0, skipped: 0 } };
  }
  
  console.log(`📦 Installing ${formulasToInstall.length} formulas from formula.yml:`);
  formulasToInstall.forEach(formula => {
    const prefix = formula.isDev ? '[dev] ' : '';
    console.log(`  • ${prefix}${formula.name}`);
  });
  console.log('');
  
  // Install formulas sequentially to avoid conflicts
  let totalInstalled = 0;
  let totalSkipped = 0;
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  
  for (const formula of formulasToInstall) {
    try {
      console.log(`\n🔧 Installing ${formula.isDev ? '[dev] ' : ''}${formula.name}...`);
      
      const installOptions: InstallOptions = { ...options, dev: formula.isDev };
      const result = await installFormulaCommand(formula.name, targetDir, installOptions);
      
      if (result.success) {
        totalInstalled++;
        results.push({ name: formula.name, success: true });
        console.log(`✅ Successfully installed ${formula.name}`);
      } else {
        totalSkipped++;
        results.push({ name: formula.name, success: false, error: result.error });
        console.log(`❌ Failed to install ${formula.name}: ${result.error}`);
      }
    } catch (error) {
      totalSkipped++;
      results.push({ name: formula.name, success: false, error: String(error) });
      console.log(`❌ Failed to install ${formula.name}: ${error}`);
    }
  }
  
  displayInstallationSummary(totalInstalled, totalSkipped, formulasToInstall.length, results);
  
  const allSuccessful = totalSkipped === 0;
  
  return {
    success: allSuccessful,
    data: {
      installed: totalInstalled,
      skipped: totalSkipped,
      results
    },
    error: allSuccessful ? undefined : `${totalSkipped} formulas failed to install`,
    warnings: totalSkipped > 0 ? [`${totalSkipped} formulas failed to install`] : undefined
  };
}

/**
 * Main install command router - handles both individual and bulk install
 * @param formulaName - Name of formula to install (optional, installs all if not provided)
 * @param targetDir - Target directory for installation
 * @param options - Installation options
 * @returns Command result with installation status and data
 */
async function installCommand(
  formulaName: string | undefined,
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  // If no formula name provided, install all from formula.yml
  if (!formulaName) {
    return await installAllFormulasCommand(targetDir, options);
  }

  // Parse formula name and version from input
  const { name, version: inputVersion } = parseFormulaInput(formulaName);

  // Install the specific formula with version
  return await installFormulaCommand(name, targetDir, options, inputVersion);
}

/**
 * Handle dry run mode for formula installation
 */
async function handleDryRunMode(
  resolvedFormulas: ResolvedFormula[],
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  formulaYmlExists: boolean
): Promise<CommandResult> {
  console.log(`🔍 Dry run - showing what would be installed:\n`);
  
  const mainFormula = resolvedFormulas.find(f => f.isRoot);
  if (mainFormula) {
    console.log(`Formula: ${mainFormula.name} v${mainFormula.version}`);
    if (mainFormula.formula.metadata.description) {
      console.log(`Description: ${mainFormula.formula.metadata.description}`);
    }
    console.log('');
  }
  
  // Show what would be installed to ai
  for (const resolved of resolvedFormulas) {
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.SKIPPED) {
      console.log(`⏭️  Would skip ${resolved.name}@${resolved.version} (user would decline overwrite)`);
      continue;
    }
    
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.KEPT) {
      console.log(`⏭️  Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    const dryRunResult = await installFormulaToGroundzero(resolved.name, targetDir, options, undefined, true);
    
    if (dryRunResult.skipped) {
      console.log(`⏭️  Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    console.log(`📁 Would install to ai${targetDir !== '.' ? '/' + targetDir : ''}: ${dryRunResult.installedCount} files`);
    
    if (dryRunResult.overwritten) {
      console.log(`  ⚠️  Would overwrite existing directory`);
    }
  }
  
  // Show formula.yml update
  if (formulaYmlExists) {
    console.log(`\n📋 Would add to .groundzero/formula.yml: ${formulaName}@${resolvedFormulas.find(f => f.isRoot)?.version}`);
  } else {
    console.log('\nNo .groundzero/formula.yml found - skipping dependency addition');
  }
  
  return {
    success: true,
    data: { 
      dryRun: true, 
      resolvedFormulas,
      totalFormulas: resolvedFormulas.length
    }
  };
}

/**
 * Process resolved formulas for installation
 */
async function processResolvedFormulas(
  resolvedFormulas: ResolvedFormula[],
  targetDir: string,
  options: InstallOptions,
  forceOverwriteFormulas?: Set<string>
): Promise<{ installedCount: number; skippedCount: number; groundzeroResults: Array<{ name: string; filesInstalled: number; overwritten: boolean }> }> {
  let installedCount = 0;
  let skippedCount = 0;
  const groundzeroResults: Array<{ name: string; filesInstalled: number; overwritten: boolean }> = [];
  
  for (const resolved of resolvedFormulas) {
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.SKIPPED) {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (user declined overwrite)`);
      continue;
    }
    
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.KEPT) {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    const shouldForceOverwrite = forceOverwriteFormulas?.has(resolved.name) || false;
    const groundzeroResult = await installFormulaToGroundzero(resolved.name, targetDir, options, undefined, shouldForceOverwrite);
    
    if (groundzeroResult.skipped) {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    installedCount++;
    groundzeroResults.push({
      name: resolved.name,
      filesInstalled: groundzeroResult.installedCount,
      overwritten: groundzeroResult.overwritten
    });
    
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.OVERWRITTEN || groundzeroResult.overwritten) {
      console.log(`🔄 Overwritten ${resolved.name}@${resolved.version} in ai`);
    }
  }
  
  return { installedCount, skippedCount, groundzeroResults };
}


/**
 * Re-resolve dependencies with version overrides to ensure correct child dependencies
 */
async function resolveDependenciesWithOverrides(
  formulaName: string,
  targetDir: string,
  versionOverrides: Map<string, string>,
  skippedFormulas: string[]
): Promise<ResolvedFormula[]> {
  // Create a custom dependency resolver that respects version overrides
  const customResolveDependencies = async (
    name: string,
    dir: string,
    isRoot: boolean = true,
    visitedStack: Set<string> = new Set(),
    resolvedFormulas: Map<string, ResolvedFormula> = new Map(),
    version?: string,
    requiredVersions: Map<string, string[]> = new Map()
  ): Promise<ResolvedFormula[]> => {
    // Skip if this formula is in the skipped list
    if (skippedFormulas.includes(name)) {
      return Array.from(resolvedFormulas.values());
    }
    
    // Use override version if available, otherwise use the specified version
    const effectiveVersion = versionOverrides.get(name) || version;
    
    // Call the original resolveDependencies with the effective version
    return await resolveDependencies(name, dir, isRoot, visitedStack, resolvedFormulas, effectiveVersion, requiredVersions);
  };
  
  // Re-resolve the entire dependency tree with overrides
  return await customResolveDependencies(formulaName, targetDir, true);
}

/**
 * Get the highest version and required version of a formula from the dependency tree
 */
async function getVersionInfoFromDependencyTree(
  formulaName: string,
  resolvedFormulas: ResolvedFormula[]
): Promise<{ highestVersion: string; requiredVersion?: string }> {
  let highestVersion = '0.0.0';
  let highestRequiredVersion: string | undefined;
  
  // Get the requiredVersions map from the first resolved formula
  const requiredVersions = (resolvedFormulas[0] as any)?.requiredVersions as Map<string, string[]> | undefined;
  
  for (const resolved of resolvedFormulas) {
    if (resolved.name === formulaName) {
      if (semver.gt(resolved.version, highestVersion)) {
        highestVersion = resolved.version;
      }
    }
  }
  
  // Get the highest required version from all specified versions for this formula
  if (requiredVersions && requiredVersions.has(formulaName)) {
    const versions = requiredVersions.get(formulaName)!;
    for (const version of versions) {
      if (!highestRequiredVersion || semver.gt(version, highestRequiredVersion)) {
        highestRequiredVersion = version;
      }
    }
  }
  
  return { highestVersion, requiredVersion: highestRequiredVersion };
}

/**
 * Check for existing formula and handle conflict resolution
 */
async function checkAndHandleFormulaConflict(
  formulaName: string,
  newVersion: string,
  resolvedFormulas: ResolvedFormula[],
  options: InstallOptions
): Promise<{ shouldProceed: boolean; action: 'keep' | 'latest' | 'exact' | 'none'; version?: string; forceOverwrite?: boolean }> {
  const cwd = process.cwd();
  
  // Check for existing formula in markdown files
  const existingCheck = await checkExistingFormulaInMarkdownFiles(cwd, formulaName);
  
  if (!existingCheck.found) {
    // No existing formula found, proceed without warning or prompts
    logger.debug(`No existing formula '${formulaName}' found, proceeding with installation`);
    return { shouldProceed: true, action: 'none', forceOverwrite: false };
  }
  
  // Existing formula found, get version info from dependency tree
  const versionInfo = await getVersionInfoFromDependencyTree(formulaName, resolvedFormulas);
  const existingVersion = existingCheck.version || 'unknown';
  
  logger.info(`Found existing formula '${formulaName}' v${existingVersion} in ${existingCheck.location}`);
  
  if (options.dryRun) {
    // In dry run mode, show what would happen but don't prompt
    return { shouldProceed: true, action: 'latest', forceOverwrite: true };
  }
  
  if (options.force) {
    // When --force is used, automatically overwrite
    logger.info(`Force flag set - automatically overwriting formula '${formulaName}' v${existingVersion}`);
    return { shouldProceed: true, action: 'latest', forceOverwrite: true };
  }
  
  try {
    const userChoice = await promptFormulaInstallConflict(formulaName, existingVersion, versionInfo.highestVersion, versionInfo.requiredVersion);
    
    switch (userChoice) {
      case 'keep':
        logger.info(`User chose to keep existing formula '${formulaName}' v${existingVersion}`);
        return { shouldProceed: false, action: 'keep', forceOverwrite: false };
        
      case 'latest':
        logger.info(`User chose to install latest version of formula '${formulaName}' v${versionInfo.highestVersion}`);
        return { shouldProceed: true, action: 'latest', forceOverwrite: true };
        
      case 'exact':
        const exactVersion = versionInfo.requiredVersion || versionInfo.highestVersion;
        logger.info(`User chose to install exact version of formula '${formulaName}' v${exactVersion}`);
        return { shouldProceed: true, action: 'exact', version: exactVersion, forceOverwrite: true };
        
      default:
        return { shouldProceed: false, action: 'keep', forceOverwrite: false };
    }
  } catch (error) {
    logger.warn(`User cancelled formula installation: ${error}`);
    return { shouldProceed: false, action: 'keep', forceOverwrite: false };
  }
}

/**
 * Check for conflicts with all formulas in the dependency tree
 */
async function checkAndHandleAllFormulaConflicts(
  resolvedFormulas: ResolvedFormula[],
  options: InstallOptions
): Promise<{ shouldProceed: boolean; skippedFormulas: string[]; versionOverrides: Map<string, string>; forceOverwriteFormulas: Set<string> }> {
  const cwd = process.cwd();
  const skippedFormulas: string[] = [];
  const versionOverrides = new Map<string, string>();
  const forceOverwriteFormulas = new Set<string>();
  
  // Check each formula in the dependency tree for conflicts
  for (const resolved of resolvedFormulas) {
    const existingCheck = await checkExistingFormulaInMarkdownFiles(cwd, resolved.name);
    
    if (existingCheck.found) {
      const versionInfo = await getVersionInfoFromDependencyTree(resolved.name, resolvedFormulas);
      const existingVersion = existingCheck.version || 'unknown';
      
      logger.info(`Found existing formula '${resolved.name}' v${existingVersion} in ${existingCheck.location}`);
      
      if (options.dryRun) {
        // In dry run mode, assume latest for all conflicts
        continue;
      }
      
      if (options.force) {
        // When --force is used, automatically overwrite all conflicts
        logger.info(`Force flag set - automatically overwriting formula '${resolved.name}' v${existingVersion}`);
        forceOverwriteFormulas.add(resolved.name);
        continue;
      }
      
      try {
        const userChoice = await promptFormulaInstallConflict(resolved.name, existingVersion, versionInfo.highestVersion, versionInfo.requiredVersion);
        
        switch (userChoice) {
          case 'keep':
            logger.info(`User chose to keep existing formula '${resolved.name}' v${existingVersion}`);
            skippedFormulas.push(resolved.name);
            break;
            
          case 'latest':
            logger.info(`User chose to install latest version of formula '${resolved.name}' v${versionInfo.highestVersion}`);
            forceOverwriteFormulas.add(resolved.name);
            break;
            
          case 'exact':
            const exactVersion = versionInfo.requiredVersion || versionInfo.highestVersion;
            logger.info(`User chose to install exact version of formula '${resolved.name}' v${exactVersion}`);
            versionOverrides.set(resolved.name, exactVersion);
            forceOverwriteFormulas.add(resolved.name);
            break;
        }
      } catch (error) {
        return handleUserCancellation(error);
      }
    }
  }
  
  return { shouldProceed: true, skippedFormulas, versionOverrides, forceOverwriteFormulas };
}

/**
 * Install formula command implementation with recursive dependency resolution
 * @param formulaName - Name of the formula to install
 * @param targetDir - Target directory for installation
 * @param options - Installation options including force, dry-run, and dev flags
 * @param version - Specific version to install (optional)
 * @returns Command result with detailed installation information
 */
async function installFormulaCommand(
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  version?: string
): Promise<CommandResult> {
  const cwd = process.cwd();
  logger.info(`Installing formula '${formulaName}' with dependencies to: ${getAIDir(cwd)}`, { options });
  
  await ensureRegistryDirectories();
  
  // Auto-create basic formula.yml if it doesn't exist
  await createBasicFormulaYml(cwd);
  
  // Resolve complete dependency tree first
  const resolvedFormulas = await resolveDependencies(formulaName, cwd, true, new Set(), new Map(), version);
  
  // Check for conflicts with all formulas in the dependency tree
  const conflictResult = await checkAndHandleAllFormulaConflicts(resolvedFormulas, options);
  
  if (!conflictResult.shouldProceed) {
    console.log(`⏭️  Installation cancelled by user`);
    return {
      success: true,
      data: {
        formulaName,
        targetDir: getAIDir(cwd),
        resolvedFormulas: [],
        totalFormulas: 0,
        installed: 0,
        skipped: 1,
        mainFilesInstalled: 0,
        totalGroundzeroFiles: 0,
        conflictsOverwritten: 0
      }
    };
  }
  
  // Filter out skipped formulas and apply version overrides
  const finalResolvedFormulas = resolvedFormulas.filter(formula => 
    !conflictResult.skippedFormulas.includes(formula.name)
  );
  
  // Apply version overrides to formulas that need specific versions
  // This requires re-resolving the entire dependency tree to ensure child dependencies are correct
  if (conflictResult.versionOverrides.size > 0) {
    console.log('\n🔄 Re-resolving dependency tree with version overrides...');
    
    // Re-resolve the entire dependency tree with version overrides
    const overrideResolvedFormulas = await resolveDependenciesWithOverrides(
      formulaName, 
      cwd, 
      conflictResult.versionOverrides, 
      conflictResult.skippedFormulas
    );
    
    // Replace the final resolved formulas with the re-resolved ones
    finalResolvedFormulas.length = 0;
    finalResolvedFormulas.push(...overrideResolvedFormulas);
    
    console.log('✅ Dependency tree re-resolved with correct versions');
  }
    
  displayDependencyTree(finalResolvedFormulas);
  
  // Check if formula.yml exists (cache the result for later use)
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  const formulaYmlExists = await exists(formulaYmlPath);

  // Handle dry-run mode
  if (options.dryRun) {
    return await handleDryRunMode(finalResolvedFormulas, formulaName, targetDir, options, formulaYmlExists);
  }

  // Process resolved formulas
  const { installedCount, skippedCount, groundzeroResults } = await processResolvedFormulas(finalResolvedFormulas, targetDir, options, conflictResult.forceOverwriteFormulas);

  // Install main formula files
  const mainFormula = finalResolvedFormulas.find(f => f.isRoot);
  let mainFilesInstalled = 0;
  let mainFileConflicts: string[] = [];

  if (mainFormula) {
    const mainResult = await installMainFormulaFiles(mainFormula, cwd, options);
    mainFilesInstalled = mainResult.installedCount;
    mainFileConflicts = mainResult.conflicts;
  }

  // Detect platforms and create directories
  const detectedPlatforms = await detectPlatforms(cwd);
  const finalPlatforms = detectedPlatforms.length > 0
    ? detectedPlatforms
    : await promptForPlatformSelection();

  const createdDirs = await createPlatformDirectoriesForInstall(cwd, finalPlatforms);

  // Add formula to formula.yml if it exists and we have a main formula
  if (formulaYmlExists && mainFormula) {
    await addFormulaToYml(cwd, formulaName, mainFormula.version, options.dev || false, version);
  }
  
  // Provide IDE-specific template files
  const ideTemplateResult = await provideIdeTemplateFiles(cwd, finalPlatforms, options);
  
  // Calculate total groundzero files
  const totalGroundzeroFiles = groundzeroResults.reduce((sum, result) => sum + result.filesInstalled, 0);
  
  // Display results
  displayInstallationResults(
    formulaName,
    finalResolvedFormulas,
    installedCount,
    skippedCount,
    mainFilesInstalled,
    totalGroundzeroFiles,
    mainFileConflicts,
    { platforms: finalPlatforms, created: createdDirs },
    ideTemplateResult,
    options,
    mainFormula
  );
  
  return {
    success: true,
    data: {
      formulaName,
      targetDir: getAIDir(cwd),
      resolvedFormulas: finalResolvedFormulas,
      totalFormulas: finalResolvedFormulas.length,
      installed: installedCount,
      skipped: skippedCount,
      mainFilesInstalled,
      totalGroundzeroFiles,
      conflictsOverwritten: mainFileConflicts.length
    }
  };
}

/**
 * Setup the install command
 * @param program - Commander program instance to register the command with
 */
export function setupInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Install formulas from local registry to codebase at cwd. Supports versioning with formula@version syntax.')
    .argument('[formula-name]', 'name of the formula to install (optional - installs all from formula.yml if not specified). Supports formula@version syntax.')
    .argument('[target-dir]', 'target directory relative to cwd/ai for /ai files only (defaults to ai root)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--force', 'overwrite existing files')
    .option('--dev', 'add formula to dev-formulas instead of formulas')
    .action(withErrorHandling(async (formulaName: string | undefined, targetDir: string, options: InstallOptions) => {
      const result = await installCommand(formulaName, targetDir, options);
      if (!result.success) {
        throw new Error(result.error || 'Installation operation failed');
      }
    }));
}

import { Command } from 'commander';
import { join, dirname } from 'path';
import * as semver from 'semver';
import { InstallOptions, CommandResult, FormulaYml } from '../types/index.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { parseMarkdownFrontmatter } from '../utils/md-frontmatter.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { checkExistingFormulaInMarkdownFiles, gatherGlobalVersionConstraints, gatherRootVersionConstraints } from '../core/groundzero.js';
import { resolveDependencies, displayDependencyTree, ResolvedFormula } from '../core/dependency-resolver.js';
import { promptConfirmation } from '../utils/prompts.js';
import { writeTextFile, exists, ensureDir, readTextFile } from '../utils/fs.js';
import { RESOURCES_RULES } from '../utils/embedded-resources.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, VersionConflictError, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import {
  PLATFORMS,
  PLATFORM_ALIASES,
  FILE_PATTERNS,
  DEPENDENCY_ARRAYS,
  CONFLICT_RESOLUTION,
  UNIVERSAL_SUBDIRS,
  type UniversalSubdir,
  type Platform
} from '../constants/index.js';
import {
  createPlatformDirectories,
  getPlatformDefinition
} from '../core/platforms.js';
import { resolveInstallTargets, mapUniversalToPlatform } from '../utils/platform-mapper.js';
import {
  getLocalFormulaYmlPath,
  getLocalFormulasDir,
  getAIDir
} from '../utils/paths.js';
import { createBasicFormulaYml, addFormulaToYml, writeLocalFormulaMetadata } from '../utils/formula-management.js';
import {
  parseFormulaInput,
  detectPlatforms,
  promptForPlatformSelection,
  displayInstallationSummary,
  displayInstallationResults
} from '../utils/formula-installation.js';
import {
  withOperationErrorHandling,
} from '../utils/error-handling.js';

/**
 * Get currently installed version from .groundzero/formulas/<formula>/formula.yml
 */
async function getInstalledFormulaVersion(cwd: string, formulaName: string): Promise<string | undefined> {
  try {
    const formulaYmlPath = join(getLocalFormulasDir(cwd), formulaName, FILE_PATTERNS.FORMULA_YML);
    if (await exists(formulaYmlPath)) {
      const config = await parseFormulaYml(formulaYmlPath);
      return config.version;
    }
  } catch {
    // ignore parse errors; treat as unknown
  }
  return undefined;
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
  return await createPlatformDirectories(targetDir, platforms as Platform[]);
}

/**
 * Normalize platform inputs: accepts variadic and comma-separated values
 */
function normalizePlatforms(input: string[] | undefined): string[] | undefined {
  if (!input || input.length === 0) return undefined;
  const flattened = input
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const aliasMap = PLATFORM_ALIASES as Record<string, string>;
  const mapped = flattened.map((name) => aliasMap[name] || name);
  return Array.from(new Set(mapped));
}

/**
 * Add groundzero and ai rule files to each platform's rulesDir
 * Uses platform definitions to determine correct file locations and extensions
 * @param targetDir - Target directory where platform directories exist
 * @param platforms - Array of platform names to add rule files for
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
    // Use centralized platform mapping to get the rules directory path
    const { absDir: rulesDirRelative } = mapUniversalToPlatform(platform as Platform, UNIVERSAL_SUBDIRS.RULES, '');
    const rulesDir = join(targetDir, rulesDirRelative);

    const rulesDirExists = await exists(rulesDir);
    if (!rulesDirExists) {
      provided.directoriesCreated.push(rulesDirRelative);
    }

    // Create rules directory (ensureDir handles existing directories gracefully)
    await ensureDir(rulesDir);

    // Get platform definition and determine file extensions
    const platformDefinition = getPlatformDefinition(platform as Platform);
    const rulesSubdirFinal = platformDefinition.subdirs[UNIVERSAL_SUBDIRS.RULES];

    if (!rulesSubdirFinal) {
      logger.warn(`Platform ${platform} does not have rules subdir defined, skipping template files`);
      return; // Skip this platform
    }

    const writeExt = rulesSubdirFinal.writeExt;

    // Generate file names using the platform's preferred extension
    const groundzeroFileName = `groundzero${writeExt}`;
    const aiFileName = `ai${writeExt}`;

    logger.debug(`Using file extension '${writeExt}' for ${platform} rules subdir`);

    // Install both groundzero and ai files
    const ruleFiles = [
      { name: groundzeroFileName, content: RESOURCES_RULES['groundzero.md'] },
      { name: aiFileName, content: RESOURCES_RULES['ai.md'] }
    ];

    for (const ruleFile of ruleFiles) {
      const ruleFilePath = join(rulesDir, ruleFile.name);
      const fileExists = await exists(ruleFilePath);

      if (fileExists && !options.force) {
        provided.skipped.push(`${rulesDirRelative}/${ruleFile.name}`);
        logger.debug(`Skipped existing ${ruleFile.name} in ${platform} rules directory`);
      } else {
        await writeTextFile(ruleFilePath, ruleFile.content);
        provided.filesAdded.push(`${rulesDirRelative}/${ruleFile.name}`);
        logger.debug(`Added ${ruleFile.name} to ${platform} rules directory: ${ruleFilePath}`);
      }
    }
  });

  await Promise.all(platformPromises);

  return provided;
}



/**
 * Categorize formula files by installation target
 * Uses universal subdirs (rules, commands, agents) mapping
 */
function categorizeFormulaFiles(files: Array<{ path: string; content: string }>) {
  const categorized: {
    aiFiles: Array<{ path: string; content: string }>;
    universalFiles: Array<{ path: string; content: string; universalSubdir: UniversalSubdir; relPath: string }>;
  } = {
    aiFiles: [],
    universalFiles: []
  };

  // AI files (files under /ai in the formula from local registry) - same as before
  categorized.aiFiles = files.filter(file =>
    file.path.startsWith('ai/') && (file.path.endsWith(FILE_PATTERNS.MD_FILES) || file.path === `ai/${FILE_PATTERNS.FORMULA_YML}`)
  );

  // Universal files - files in universal subdirectories should be installed to all platforms
  // that support that subdirectory type
  for (const file of files) {
    // Skip AI files (already handled above)
    if (file.path.startsWith('ai/')) {
      continue;
    }

    // Check universal subdirectories (rules, commands, agents)
    for (const subdir of Object.values(UNIVERSAL_SUBDIRS) as UniversalSubdir[]) {
      if (file.path.startsWith(`${subdir}/`)) {
        // Extract relative path within the subdir
        const relPath = file.path.substring(subdir.length + 1); // +1 for the slash
        categorized.universalFiles.push({
          ...file,
          universalSubdir: subdir,
          relPath
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
  dryRun: boolean = false,
  currentFormulaName?: string
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

    const isMarkdown = targetPath.endsWith(FILE_PATTERNS.MD_FILES) || targetPath.endsWith(FILE_PATTERNS.MDC_FILES);
    const fileExists = await exists(targetPath);

    // Determine action
    let shouldWrite = !fileExists; // write if it doesn't exist
    let autoOverwrite = false;
    let needsPrompt = false;
    let promptReason: 'no-frontmatter' | 'different-formula' | 'non-markdown' | null = null;

    if (fileExists && !options.force) {
      if (isMarkdown && currentFormulaName) {
        try {
          const existingContent = await readTextFile(targetPath);
          const fm = parseMarkdownFrontmatter(existingContent);
          const existingName = fm?.formula?.name;
          if (existingName && existingName.trim().toLowerCase() === currentFormulaName.trim().toLowerCase()) {
            autoOverwrite = true;
            shouldWrite = true;
          } else {
            needsPrompt = true;
            promptReason = existingName ? 'different-formula' : 'no-frontmatter';
          }
        } catch {
          needsPrompt = true;
          promptReason = 'no-frontmatter';
        }
      } else {
        needsPrompt = true;
        promptReason = 'non-markdown';
      }
    } else if (fileExists && options.force) {
      shouldWrite = true; // force overwrite
    }

    if (dryRun) {
      if (!fileExists) {
        logger.debug(`Would install ${pathPrefix.slice(0, -1)} file: ${relativePath}`);
        installedFiles.push(`${pathPrefix.slice(0, -1)}/${relativePath}`);
        installedCount++;
      } else if (options.force || autoOverwrite) {
        const reason = options.force ? 'force' : 'matching frontmatter';
        logger.debug(`Would overwrite ${pathPrefix.slice(0, -1)} file: ${relativePath} (${reason})`);
        installedFiles.push(`${pathPrefix.slice(0, -1)}/${relativePath}`);
        installedCount++;
      } else if (needsPrompt) {
        logger.debug(`Would prompt before overwriting existing file: ${targetPath} (${promptReason})`);
      }
      continue;
    }

    if (needsPrompt && !options.force) {
      const reasonText = promptReason === 'different-formula'
        ? 'Frontmatter formula.name differs from installing formula'
        : promptReason === 'no-frontmatter'
          ? 'No formula frontmatter found in the file'
          : 'Existing file is not a markdown file';
      const confirmed = await promptConfirmation(`Overwrite existing file?
Path: ${targetPath}
Reason: ${reasonText}`);
      if (!confirmed) {
        // Skip this file
        if (pathPrefix === 'ai/') {
          console.log(`⏭️  Skipped existing file: ${targetPath}`);
        } else {
          logger.debug(`Skipped existing ${pathPrefix.slice(0, -1)} file: ${targetPath}`);
        }
        continue;
      }
      shouldWrite = true;
    }

    if (shouldWrite) {
      await writeTextFile(targetPath, file.content);
      if (fileExists && (options.force || autoOverwrite)) {
        const reason = options.force ? 'force' : 'matching frontmatter';
        logger.debug(`Overwritten ${pathPrefix.slice(0, -1)} file: ${relativePath} (${reason})`);
      } else {
        logger.debug(`Installed ${pathPrefix.slice(0, -1)} file: ${relativePath}`);
      }
      installedFiles.push(`${pathPrefix.slice(0, -1)}/${relativePath}`);
      installedCount++;
    }
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
async function installFormula(
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

  // Copy registry formula.yml and README.md to local project structure
  const readmeFile = formula.files.find(f => f.path === FILE_PATTERNS.README_MD);
  await writeLocalFormulaMetadata(cwd, formulaName, formula.metadata, readmeFile?.content);
  
  logger.debug(`Copied registry formula.yml for ${formulaName} to local project`);
  if (readmeFile) {
    logger.debug(`Copied README.md for ${formulaName} to local project`);
  }

  // Create modified options with force flag if needed
  const installOptions = forceOverwrite ? { ...options, force: true } : options;

  // Categorize and install files
  const { aiFiles, universalFiles } = categorizeFormulaFiles(formula.files);

  // Install AI files directly to ai/ (not ai/formulaName/)
  const aiResult = await installFileType(aiFiles, aiGroundzeroPath, 'ai/', installOptions, options.dryRun, formulaName);

  // Install universal files to all detected platforms that support each subdir
  const universalResults = await Promise.all(
    universalFiles.map(async (file) => {
      const targets = await resolveInstallTargets(cwd, {
        universalSubdir: file.universalSubdir,
        relPath: file.relPath,
        sourceExt: file.path.endsWith('.toml') ? '.toml' : FILE_PATTERNS.MD_FILES
      });

      // Special case: Skip GEMINICLI commands files (they are .toml files, not .md files)
      const filteredTargets = targets.filter(target => {
        if (target.platform === PLATFORMS.GEMINICLI &&
            file.universalSubdir === UNIVERSAL_SUBDIRS.COMMANDS &&
            file.path.endsWith('.toml')) {
          logger.debug(`Skipping GEMINICLI .toml commands file: ${file.path}`);
          return false;
        }
        return true;
      });

      // Install to each target
      const targetResults = await Promise.all(
        filteredTargets.map(async (target) => {
          // Calculate relative path from platform subdir root to preserve directory structure
          const relativePath = target.absFile.substring(target.absDir.length + 1); // +1 for the slash
          const adjustedFile = {
            ...file,
            path: relativePath
          };
          // Use platform-aware path prefix for proper reporting
          const platformDef = getPlatformDefinition(target.platform);
          const rulesSubdir = platformDef.subdirs[file.universalSubdir];
          const platformPathPrefix = join(platformDef.rootDir, rulesSubdir?.path || file.universalSubdir) + '/';
          return await installFileType(
            [adjustedFile],
            target.absDir,
            platformPathPrefix,
            installOptions,
            options.dryRun,
            formulaName
          );
        })
      );

      // Combine results from all targets
      const totalInstalled = targetResults.reduce((sum, result) => sum + result.installedCount, 0);
      const allFiles = targetResults.flatMap(result => result.files);
      return { installedCount: totalInstalled, files: allFiles };
    })
  );
  
  const totalInstalled = aiResult.installedCount + universalResults.reduce((sum, result) => sum + result.installedCount, 0);
  const allFiles = [...aiResult.files, ...universalResults.flatMap(result => result.files)];
  
  return {
    installedCount: totalInstalled,
    files: allFiles,
    overwritten: false,
    skipped: false
  };
}


/**
 * Extract formulas from formula.yml configuration
 */
function extractFormulasFromConfig(config: FormulaYml): Array<{ name: string; isDev: boolean; version?: string }> {
  const formulas: Array<{ name: string; isDev: boolean; version?: string }> = [];
  
  // Add production formulas
  config.formulas?.forEach(formula => {
    formulas.push({ name: formula.name, isDev: false, version: formula.version });
  });
  
  // Add dev formulas
  config[DEPENDENCY_ARRAYS.DEV_FORMULAS]?.forEach(formula => {
    formulas.push({ name: formula.name, isDev: true, version: formula.version });
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
    const label = formula.version ? `${formula.name}@${formula.version}` : formula.name;
    console.log(`  • ${prefix}${label}`);
  });
  console.log('');
  
  // Install formulas sequentially to avoid conflicts
  let totalInstalled = 0;
  let totalSkipped = 0;
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  
  for (const formula of formulasToInstall) {
    try {
      const label = formula.version ? `${formula.name}@${formula.version}` : formula.name;
      console.log(`\n🔧 Installing ${formula.isDev ? '[dev] ' : ''}${label}...`);
      
      const installOptions: InstallOptions = { ...options, dev: formula.isDev };
      const result = await installFormulaCommand(formula.name, targetDir, installOptions, formula.version);
      
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
      if (error instanceof UserCancellationError) {
        throw error; // Re-throw to allow clean exit
      }
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
    
    const dryRunResult = await installFormula(resolved.name, targetDir, options, resolved.version, true);
    
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
): Promise<{ installedCount: number; skippedCount: number; groundzeroResults: Array<{ name: string; filesInstalled: number; files: string[]; overwritten: boolean }> }> {
  let installedCount = 0;
  let skippedCount = 0;
  const groundzeroResults: Array<{ name: string; filesInstalled: number; files: string[]; overwritten: boolean }> = [];
  
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
    const groundzeroResult = await installFormula(resolved.name, targetDir, options, resolved.version, shouldForceOverwrite);
    
    if (groundzeroResult.skipped) {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    installedCount++;
    groundzeroResults.push({
      name: resolved.name,
      filesInstalled: groundzeroResult.installedCount,
      files: groundzeroResult.files,
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
  skippedFormulas: string[],
  globalConstraints?: Map<string, string[]>,
  version?: string
): Promise<ResolvedFormula[]> {
  // Re-gather root constraints (which now includes any newly persisted versions)
  const rootConstraints = await gatherRootVersionConstraints(targetDir);
  
  // Filter out skipped formulas by creating a wrapper
  const customResolveDependencies = async (
    name: string,
    dir: string,
    isRoot: boolean = true,
    visitedStack: Set<string> = new Set(),
    resolvedFormulas: Map<string, ResolvedFormula> = new Map(),
    ver?: string,
    requiredVersions: Map<string, string[]> = new Map(),
    globalConst?: Map<string, string[]>,
    rootOver?: Map<string, string[]>
  ): Promise<ResolvedFormula[]> => {
    // Skip if this formula is in the skipped list
    if (skippedFormulas.includes(name)) {
      return Array.from(resolvedFormulas.values());
    }
    
    return await resolveDependencies(
      name,
      dir,
      isRoot,
      visitedStack,
      resolvedFormulas,
      ver,
      requiredVersions,
      globalConst,
      rootOver
    );
  };
  
  // Re-resolve the entire dependency tree with updated root constraints
  return await customResolveDependencies(
    formulaName,
    targetDir,
    true,
    new Set(),
    new Map(),
    version,
    new Map(),
    globalConstraints,
    rootConstraints
  );
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
  const existingVersion = existingCheck.version || await getInstalledFormulaVersion(cwd, formulaName);
  
  if (existingVersion) {
    logger.debug(`Found existing formula '${formulaName}' v${existingVersion} in ${existingCheck.location}`);
  } else {
    logger.debug(`Found existing formula '${formulaName}' in ${existingCheck.location}`);
  }
  
  if (options.dryRun) {
    // In dry run mode, proceed without forcing; per-file logic will report decisions
    return { shouldProceed: true, action: 'latest', forceOverwrite: false };
  }
  
  if (options.force) {
    // When --force is used, automatically overwrite
    logger.info(`Force flag set - automatically overwriting formula '${formulaName}' v${existingVersion}`);
    return { shouldProceed: true, action: 'latest', forceOverwrite: true };
  }
  
  // Proceed without prompting; per-file frontmatter-aware logic will handle overwrite decisions
  logger.info(`Proceeding without global prompt for '${formulaName}'; per-file frontmatter will govern overwrites.`);
  return { shouldProceed: true, action: 'latest', forceOverwrite: false };
}

/**
 * Check for conflicts with all formulas in the dependency tree
 */
async function checkAndHandleAllFormulaConflicts(
  resolvedFormulas: ResolvedFormula[],
  options: InstallOptions
): Promise<{ shouldProceed: boolean; skippedFormulas: string[]; forceOverwriteFormulas: Set<string> }> {
  const cwd = process.cwd();
  const skippedFormulas: string[] = [];
  const forceOverwriteFormulas = new Set<string>();
  
  // Check each formula in the dependency tree for conflicts
  for (const resolved of resolvedFormulas) {
    const existingCheck = await checkExistingFormulaInMarkdownFiles(cwd, resolved.name);
    
    if (existingCheck.found) {
      const versionInfo = await getVersionInfoFromDependencyTree(resolved.name, resolvedFormulas);
      const existingVersion = existingCheck.version || await getInstalledFormulaVersion(cwd, resolved.name);
      
      if (existingVersion) {
        logger.debug(`Found existing formula '${resolved.name}' v${existingVersion} in ${existingCheck.location}`);
      } else {
        logger.debug(`Found existing formula '${resolved.name}' in ${existingCheck.location}`);
      }
      
      if (options.dryRun) {
        // In dry run mode, proceed; per-file logic will report decisions
        continue;
      }
      
      if (options.force) {
        // When --force is used, automatically overwrite all conflicts
        logger.info(`Force flag set - automatically overwriting formula '${resolved.name}' v${existingVersion}`);
        forceOverwriteFormulas.add(resolved.name);
        continue;
      }
      
      // Prompt per formula overwrite confirmation when existing detected
      const { promptFormulaOverwrite } = await import('../utils/prompts.js');
      const confirmed = await promptFormulaOverwrite(resolved.name, existingVersion);
      if (confirmed) {
        forceOverwriteFormulas.add(resolved.name);
      } else {
        skippedFormulas.push(resolved.name);
      }
      continue;
    }
  }
  
  return { shouldProceed: true, skippedFormulas, forceOverwriteFormulas };
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
  logger.debug(`Installing formula '${formulaName}' with dependencies to: ${getAIDir(cwd)}`, { options });
  
  await ensureRegistryDirectories();
  
  // Auto-create basic formula.yml if it doesn't exist
  await createBasicFormulaYml(cwd);

  // If platforms are specified, validate and prepare directories ahead of detection
  const specifiedPlatforms = normalizePlatforms(options.platforms);
  if (specifiedPlatforms && specifiedPlatforms.length > 0) {
    // Validate against known platforms
    const knownPlatforms = new Set<string>(Object.values(PLATFORMS));
    for (const p of specifiedPlatforms) {
      if (!knownPlatforms.has(p)) {
        return { success: false, error: `platform ${p} not found` };
      }
    }
    // Create platform directories unless dry-run
    if (!options.dryRun) {
      await createPlatformDirectoriesForInstall(cwd, specifiedPlatforms);
    }
  }
  
  // Resolve complete dependency tree first, with conflict handling and persistence
  const globalConstraints = await gatherGlobalVersionConstraints(cwd);
  let resolvedFormulas: ResolvedFormula[];
  try {
    const rootConstraints = await gatherRootVersionConstraints(cwd);
    resolvedFormulas = await resolveDependencies(
      formulaName,
      cwd,
      true,
      new Set(),
      new Map(),
      version,
      new Map(),
      globalConstraints,
      rootConstraints
    );
  } catch (error) {
    if (error instanceof VersionConflictError) {
      // Decide version: if --force, take highest available; else prompt user to select
      const { details } = (error as any) || {};
      const depName = details?.formulaName || (error as any).details?.formulaName || (error as any).code;
      const name = (error as any).details?.formulaName || (error as any).details?.formula || formulaName; // fallback
      const available: string[] = details?.availableVersions || (error as any).details?.availableVersions || [];

      let chosenVersion: string | null = null;
      if (options.force) {
        // pick highest available version
        chosenVersion = available.sort((a, b) => semver.rcompare(a, b))[0] || null;
      } else {
        // ask user to pick a version from available
        const { promptVersionSelection } = await import('../utils/prompts.js');
        chosenVersion = await promptVersionSelection(details?.formulaName || name, available, 'to install');
      }

      if (!chosenVersion) {
        return { success: false, error: `Unable to resolve version for ${(error as any).details?.formulaName || name}` };
      }

      // Persist chosen version by promoting to direct dependency in main formula.yml
      await addFormulaToYml(cwd, (error as any).details?.formulaName || name, chosenVersion!, false, chosenVersion!, true);

      // Recompute constraints (now includes the persisted version in root) and re-resolve
      const updatedConstraints = await gatherGlobalVersionConstraints(cwd);
      const overrideResolvedFormulas = await resolveDependenciesWithOverrides(
        formulaName,
        cwd,
        [],
        updatedConstraints,
        version
      );
      resolvedFormulas = overrideResolvedFormulas;
    } else if (
      error instanceof FormulaNotFoundError ||
      (error instanceof Error && (
        error.message.includes('not available in local registry') ||
        (error.message.includes('Formula') && error.message.includes('not found'))
      ))
    ) {
      console.log('❌ Formula not found');
      return { success: false, error: 'Formula not found' };
    } else {
      throw error;
    }
  }
  
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
        totalGroundzeroFiles: 0
      }
    };
  }
  
  // Filter out skipped formulas
  const finalResolvedFormulas = resolvedFormulas.filter(formula => 
    !conflictResult.skippedFormulas.includes(formula.name)
  );
    
  displayDependencyTree(finalResolvedFormulas, true);
  
  // Check if formula.yml exists (cache the result for later use)
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  const formulaYmlExists = await exists(formulaYmlPath);

  // Handle dry-run mode
  if (options.dryRun) {
    return await handleDryRunMode(finalResolvedFormulas, formulaName, targetDir, options, formulaYmlExists);
  }

  // Process resolved formulas
  const { installedCount, skippedCount, groundzeroResults } = await processResolvedFormulas(finalResolvedFormulas, targetDir, options, conflictResult.forceOverwriteFormulas);

  // Get main formula for formula.yml updates and display
  const mainFormula = finalResolvedFormulas.find(f => f.isRoot);

  // Detect platforms and create directories (prefer specified if provided)
  let finalPlatforms = await detectPlatforms(cwd);
  if (specifiedPlatforms && specifiedPlatforms.length > 0) {
    finalPlatforms = specifiedPlatforms;
  } else if (finalPlatforms.length === 0) {
    finalPlatforms = await promptForPlatformSelection();
  }

  const createdDirs = await createPlatformDirectoriesForInstall(cwd, finalPlatforms);

  // Add formula to formula.yml if it exists and we have a main formula
  if (formulaYmlExists && mainFormula) {
    await addFormulaToYml(cwd, formulaName, mainFormula.version, options.dev || false, version, true);
  }
  
  // Provide IDE-specific template files (use specified/detected platforms)
  const ideTemplateResult = await provideIdeTemplateFiles(cwd, finalPlatforms, options);
  
  // Collect all added files
  const allAddedFiles: string[] = [];

  // Add AI files from groundzero results
  groundzeroResults.forEach(result => {
    allAddedFiles.push(...result.files);
  });

  // Add IDE template files
  allAddedFiles.push(...ideTemplateResult.filesAdded);

  // Calculate total groundzero files
  const totalGroundzeroFiles = groundzeroResults.reduce((sum, result) => sum + result.filesInstalled, 0);
  
  // Display results
  displayInstallationResults(
    formulaName,
    finalResolvedFormulas,
    { platforms: finalPlatforms, created: createdDirs },
    ideTemplateResult,
    options,
    mainFormula,
    allAddedFiles
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
      totalGroundzeroFiles
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
    .option('--platforms <platforms...>', 'prepare specific platforms (e.g., cursor claudecode opencode)')
    .action(withErrorHandling(async (formulaName: string | undefined, targetDir: string, options: InstallOptions) => {
      // Normalize platforms option early for downstream logic
      options.platforms = normalizePlatforms(options.platforms);
      const result = await installCommand(formulaName, targetDir, options);
      if (!result.success) {
        if (result.error === 'Formula not found') {
          // Handled case: already printed minimal message, do not bubble to global handler
          return;
        }
        throw new Error(result.error || 'Installation operation failed');
      }
    }));
}

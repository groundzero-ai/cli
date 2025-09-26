import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import * as semver from 'semver';
import { InstallOptions, CommandResult, FormulaYml, FormulaDependency, Formula } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { checkExistingFormulaInMarkdownFiles } from '../core/groundzero.js';
import { resolveDependencies, displayDependencyTree, ResolvedFormula } from '../core/dependency-resolver.js';
import { promptPlatformSelection, promptFormulaInstallConflict } from '../utils/prompts.js';
import { writeTextFile, exists, ensureDir } from '../utils/fs.js';
import { CURSOR_TEMPLATES, CLAUDE_TEMPLATES } from '../utils/embedded-templates.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { 
  parseVersionRange, 
  isExactVersion, 
  createCaretRange,
} from '../utils/version-ranges.js';
import { 
  PLATFORM_DIRS, 
  PLATFORMS,
  FILE_PATTERNS, 
  DEPENDENCY_ARRAYS, 
  CONFLICT_RESOLUTION, 
  GLOBAL_PLATFORM_FILES,
  GROUNDZERO_DIRS
} from '../constants/index.js';
import { 
  detectAllPlatforms, 
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

/**
 * Ensure local GroundZero directory structure exists
 */
async function ensureLocalGroundZeroStructure(cwd: string): Promise<void> {
  const groundzeroDir = getLocalGroundZeroDir(cwd);
  const formulasDir = getLocalFormulasDir(cwd);
  
  await Promise.all([
    ensureDir(groundzeroDir),
    ensureDir(formulasDir)
  ]);
}

/**
 * Copy registry formula.yml to local project structure
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
 * Parse formula input to extract name and version/range
 */
function parseFormulaInput(formulaInput: string): { name: string; version?: string } {
  const atIndex = formulaInput.lastIndexOf('@');
  
  if (atIndex === -1) {
    return { name: formulaInput };
  }
  
  const name = formulaInput.substring(0, atIndex);
  const version = formulaInput.substring(atIndex + 1);
  
  if (!name || !version) {
    throw new ValidationError(`Invalid formula syntax: ${formulaInput}. Use format: formula@version or formula@range`);
  }
  
  // Validate the version/range format
  try {
    parseVersionRange(version);
  } catch (error) {
    throw new ValidationError(`Invalid version/range format: ${version}. ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  return { name, version };
}

/**
 * Create a basic formula.yml file if it doesn't exist
 */
async function createBasicFormulaYml(cwd: string): Promise<void> {
  await ensureLocalGroundZeroStructure(cwd);
  
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  
  if (await exists(formulaYmlPath)) {
    return; // formula.yml already exists, no need to create
  }
  
  const projectName = basename(cwd);
  const basicFormulaYml: FormulaYml = {
    name: projectName,
    version: '0.1.0',
    formulas: [],
    'dev-formulas': []
  };
  
  await writeFormulaYml(formulaYmlPath, basicFormulaYml);
  logger.info(`Created basic formula.yml with name: ${projectName}`);
  console.log(`📋 Created basic formula.yml in .groundzero/ with name: ${projectName}`);
}

/**
 * Detect existing platforms and manage platform configuration
 */
async function detectAndManagePlatforms(
  targetDir: string,
  options: InstallOptions
): Promise<{ platforms: string[]; created: string[] }> {
  const formulaYmlPath = getLocalFormulaYmlPath(targetDir);
  
  // Detect all platforms using the centralized platform detection
  const platformDetectionResults = await detectAllPlatforms(targetDir);
  const detectedPlatforms = platformDetectionResults
    .filter(result => result.detected)
    .map(result => result.name);
  
  // Parse formula.yml if it exists
  let formulaConfig: FormulaYml | null = null;
  const formulaYmlExists = await exists(formulaYmlPath);
  
  if (formulaYmlExists) {
    try {
      formulaConfig = await parseFormulaYml(formulaYmlPath);
    } catch (error) {
      logger.warn(`Failed to parse formula.yml: ${error}`);
    }
  }
  
  // Determine final platforms
  let finalPlatforms: string[];
  const shouldPrompt = !formulaConfig?.platforms && detectedPlatforms.length === 0;
  
  if (formulaConfig?.platforms) {
    finalPlatforms = formulaConfig.platforms;
    logger.debug(`Using existing platforms from formula.yml: ${finalPlatforms.join(', ')}`);
  } else if (detectedPlatforms.length > 0) {
    finalPlatforms = detectedPlatforms;
    logger.info(`Auto-detected platforms: ${finalPlatforms.join(', ')}`);
  } else if (shouldPrompt) {
    console.log('\n🤖 Platform Detection');
    console.log('No AI development platform detected in this project.');
    
    finalPlatforms = await promptPlatformSelection();
  } else {
    finalPlatforms = [];
  }
  
  // Create directories for selected platforms using centralized platform management
  const created = await createPlatformDirectories(targetDir, finalPlatforms as PlatformName[]);
  
  // Update formula.yml if needed
  if (formulaConfig && !formulaConfig.platforms && finalPlatforms.length >= 0) {
    formulaConfig.platforms = finalPlatforms;
    await writeFormulaYml(formulaYmlPath, formulaConfig);
    logger.debug(`Updated formula.yml platforms: ${finalPlatforms.join(', ')}`);
  }
  
  return { platforms: finalPlatforms, created };
}

/**
 * Provide IDE-specific template files based on detected platforms
 * Note: Global platform files (groundzero.mdc, groundzero.md) are shared across all formulas
 */
async function provideIdeTemplateFiles(
  targetDir: string,
  platforms: string[],
  options: InstallOptions
): Promise<{ cursor: string[]; claude: string[]; skipped: string[]; directoriesCreated: string[] }> {
  const provided = { 
    cursor: [] as string[], 
    claude: [] as string[], 
    skipped: [] as string[], 
    directoriesCreated: [] as string[] 
  };
  
  // Process platforms in parallel
  const platformPromises = platforms.map(async (platform) => {
    const platformDefinition = getPlatformDefinition(platform as PlatformName);
    const platformDir = join(targetDir, PLATFORM_DIRS[platform.toUpperCase() as keyof typeof PLATFORM_DIRS]);
    
    logger.info(`Providing ${platform} IDE templates`);
    
    const platformDirExists = await exists(platformDir);
    if (!platformDirExists) {
      provided.directoriesCreated.push(PLATFORM_DIRS[platform.toUpperCase() as keyof typeof PLATFORM_DIRS]);
    }
    
    // Create platform directory structure
    await ensureDir(platformDir);
    
    // Determine the appropriate template file and content
    let templateFile: string;
    let templateContent: string;
    let globalFileKey: string;
    
    if (platform === PLATFORMS.CURSOR) {
      const rulesDir = join(platformDir, 'rules');
      await ensureDir(rulesDir);
      templateFile = join(rulesDir, FILE_PATTERNS.GROUNDZERO_MDC);
      templateContent = CURSOR_TEMPLATES[FILE_PATTERNS.GROUNDZERO_MDC];
      globalFileKey = GLOBAL_PLATFORM_FILES.CURSOR_GROUNDZERO;
    } else {
      // All other platforms use .md files
      templateFile = join(platformDir, FILE_PATTERNS.GROUNDZERO_MD);
      templateContent = CLAUDE_TEMPLATES[FILE_PATTERNS.GROUNDZERO_MD];
      globalFileKey = GLOBAL_PLATFORM_FILES[`${platform.toUpperCase()}_GROUNDZERO` as keyof typeof GLOBAL_PLATFORM_FILES];
    }
    
    const fileExists = await exists(templateFile);
    
    if (fileExists && !options.force) {
      provided.skipped.push(globalFileKey);
      logger.debug(`Skipped existing global ${platform} template: ${globalFileKey}`);
    } else {
      await writeTextFile(templateFile, templateContent);
      
      if (platform === PLATFORMS.CURSOR) {
        provided.cursor.push(FILE_PATTERNS.GROUNDZERO_MDC);
      } else {
        provided.claude.push(FILE_PATTERNS.GROUNDZERO_MD);
      }
      
      logger.debug(`Provided global ${platform} template: ${globalFileKey}`);
    }
  });
  
  await Promise.all(platformPromises);
  
  return provided;
}

/**
 * Find where a formula currently exists in formula.yml
 */
async function findFormulaLocation(
  cwd: string,
  formulaName: string
): Promise<'formulas' | 'dev-formulas' | null> {
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  if (!(await exists(formulaYmlPath))) {
    return null;
  }
  
  try {
    const config = await parseFormulaYml(formulaYmlPath);
    
    // Check both arrays efficiently
    if (config.formulas?.some(dep => dep.name === formulaName)) {
      return DEPENDENCY_ARRAYS.FORMULAS;
    }
    
    if (config[DEPENDENCY_ARRAYS.DEV_FORMULAS]?.some(dep => dep.name === formulaName)) {
      return DEPENDENCY_ARRAYS.DEV_FORMULAS;
    }
    
    return null;
  } catch (error) {
    logger.warn(`Failed to parse formula.yml: ${error}`);
    return null;
  }
}

/**
 * Add a formula dependency to formula.yml with smart placement logic
 */
async function addFormulaToYml(
  cwd: string, 
  formulaName: string, 
  formulaVersion: string, 
  isDev: boolean = false,
  originalVersion?: string // The original version/range that was requested
): Promise<void> {
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  if (!(await exists(formulaYmlPath))) {
    return; // If no formula.yml exists, ignore this step
  }
  
  const config = await parseFormulaYml(formulaYmlPath);
  
  // Determine the version to write to formula.yml
  let versionToWrite: string;
  let versionRange: string | undefined;
  
  if (originalVersion) {
    // If we have the original version/range, use it
    versionToWrite = originalVersion;
    versionRange = originalVersion;
  } else {
    // Default behavior: use caret range for unspecified versions, exact for specified
    // This mimics npm behavior
    if (isExactVersion(formulaVersion)) {
      // If it's an exact version, use caret range (^1.2.3)
      versionToWrite = createCaretRange(formulaVersion);
      versionRange = versionToWrite;
    } else {
      // If it's already a range, use it as-is
      versionToWrite = formulaVersion;
      versionRange = formulaVersion;
    }
  }
  
  const dependency: FormulaDependency = { 
    name: formulaName, 
    version: versionToWrite
  };
  
  // Find current location and determine target location
  const currentLocation = await findFormulaLocation(cwd, formulaName);
  
  let targetArray: 'formulas' | 'dev-formulas';
  if (currentLocation === DEPENDENCY_ARRAYS.DEV_FORMULAS && !isDev) {
    targetArray = DEPENDENCY_ARRAYS.DEV_FORMULAS;
    logger.info(`Keeping formula in dev-formulas: ${formulaName}@${formulaVersion}`);
  } else if (currentLocation === DEPENDENCY_ARRAYS.FORMULAS && isDev) {
    targetArray = DEPENDENCY_ARRAYS.DEV_FORMULAS;
    logger.info(`Moving formula from formulas to dev-formulas: ${formulaName}@${formulaVersion}`);
  } else {
    targetArray = isDev ? DEPENDENCY_ARRAYS.DEV_FORMULAS : DEPENDENCY_ARRAYS.FORMULAS;
  }
  
  // Initialize arrays if they don't exist
  if (!config.formulas) config.formulas = [];
  if (!config[DEPENDENCY_ARRAYS.DEV_FORMULAS]) config[DEPENDENCY_ARRAYS.DEV_FORMULAS] = [];
  
  // Remove from current location if moving between arrays
  if (currentLocation && currentLocation !== targetArray) {
    const currentArray = config[currentLocation]!;
    const currentIndex = currentArray.findIndex(dep => dep.name === formulaName);
    if (currentIndex >= 0) {
      currentArray.splice(currentIndex, 1);
    }
  }
  
  // Update or add dependency
  const targetArrayRef = config[targetArray]!;
  const existingIndex = targetArrayRef.findIndex(dep => dep.name === formulaName);
  
  if (existingIndex >= 0) {
    targetArrayRef[existingIndex] = dependency;
    logger.info(`Updated existing formula dependency: ${formulaName}@${formulaVersion}`);
  } else {
    targetArrayRef.push(dependency);
    logger.info(`Added new formula dependency: ${formulaName}@${formulaVersion}`);
  }
  
  await writeFormulaYml(formulaYmlPath, config);
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
  
  // Platform files - categorize by platform directory structure
  for (const file of files) {
    // Skip AI files (already handled above)
    if (file.path.startsWith('ai/')) {
      continue;
    }
    
    // Check each platform directory
    for (const [platformKey, platformDir] of Object.entries(PLATFORM_DIRS)) {
      if (platformKey === 'GROUNDZERO' || platformKey === 'AI') continue; // Skip these
      
      if (file.path.startsWith(`${platformDir}/`)) {
        categorized.platformFiles.push({
          ...file,
          platform: platformKey.toLowerCase(),
          platformDir
        });
        break;
      }
    }
  }
  
  return categorized;
}

/**
 * Install files of a specific type to target directory
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
      
      await ensureDir(dirname(targetPath));
      await writeTextFile(targetPath, file.content);
      logger.debug(`Installed ${pathPrefix.slice(0, -1)} file: ${relativePath}`);
    }
    
    installedFiles.push(pathPrefix === 'ai/' ? relativePath : `${pathPrefix.slice(0, -1)}/${relativePath}`);
    installedCount++;
  }
  
  return { installedCount, files: installedFiles };
}

/**
 * Install formula files to ai/formulaName directory
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
  
  // Determine formula groundzero path
  const formulaGroundzeroPath = targetDir && targetDir !== '.' 
    ? join(groundzeroPath, targetDir.startsWith('/') ? targetDir.slice(1) : targetDir)
    : join(groundzeroPath, formulaName);
  
  await ensureDir(groundzeroPath);
  
  // Load formula
  const formula = await formulaManager.loadFormula(formulaName, version);
  
  // Copy registry formula.yml to local project structure
  await copyRegistryFormulaYml(cwd, formulaName, formula);
  
  // Create modified options with force flag if needed
  const installOptions = forceOverwrite ? { ...options, force: true } : options;
  
  // Categorize and install files
  const { aiFiles, platformFiles } = categorizeFormulaFiles(formula.files);
  
  // Install AI files (same as before)
  const aiResult = await installFileType(aiFiles, formulaGroundzeroPath, 'ai/', installOptions, options.dryRun);
  
  // Install platform files to their respective directories
  const platformResults = await Promise.all(
    platformFiles.map(async (file) => {
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
        targetDir = join(targetDir, platformDefinition.rulesDir.split('/').pop() || 'rules');
      } else if (file.path.includes(`/${GROUNDZERO_DIRS.COMMANDS}/`)) {
        if (platformDefinition.commandsDir) {
          targetDir = join(targetDir, platformDefinition.commandsDir.split('/').pop() || 'commands');
        } else {
          // Skip if platform doesn't support commands
          logger.debug(`Skipping commands file for platform ${platform} (not supported): ${file.path}`);
          return { installedCount: 0, files: [] };
        }
      } else if (file.path.includes(`/${GROUNDZERO_DIRS.AGENTS}/`)) {
        if (platformDefinition.agentsDir) {
          targetDir = join(targetDir, platformDefinition.agentsDir.split('/').pop() || 'agents');
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
  
  // Install files in parallel
  const installPromises = existenceChecks.map(async ({ file, targetPath }) => {
    try {
      await ensureDir(dirname(targetPath));
      await writeTextFile(targetPath, file.content);
      logger.debug(`Installed file: ${targetPath}`);
      return true;
    } catch (error) {
      logger.error(`Failed to install file: ${targetPath}`, { error });
      throw new ValidationError(`Failed to install file ${targetPath}: ${error}`);
    }
  });
  
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
 * Display installation summary
 */
function displayInstallationSummary(
  totalInstalled: number,
  totalSkipped: number,
  totalFormulas: number,
  results: Array<{ name: string; success: boolean; error?: string }>
): void {
  console.log(`\n📊 Installation Summary:`);
  console.log(`✅ Successfully installed: ${totalInstalled}/${totalFormulas} formulas`);
  
  if (totalSkipped > 0) {
    console.log(`❌ Failed to install: ${totalSkipped} formulas`);
    console.log('\nFailed formulas:');
    results.filter(r => !r.success).forEach(result => {
      console.log(`  • ${result.name}: ${result.error}`);
    });
  }
}

/**
 * Install all formulas from CWD formula.yml file
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
  
  let cwdConfig: FormulaYml;
  try {
    cwdConfig = await parseFormulaYml(formulaYmlPath);
  } catch (error) {
    throw new Error(`Failed to parse formula.yml: ${error}`);
  }
  
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
  options: InstallOptions
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
    
    console.log(`📁 Would install to ai/${resolved.name}: ${dryRunResult.installedCount} files`);
    
    if (dryRunResult.overwritten) {
      console.log(`  ⚠️  Would overwrite existing directory`);
    }
  }
  
  // Show formula.yml update
  const formulaYmlPath = getLocalFormulaYmlPath(process.cwd());
  if (await exists(formulaYmlPath)) {
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
 * Display installation results
 */
function displayInstallationResults(
  formulaName: string,
  resolvedFormulas: ResolvedFormula[],
  installedCount: number,
  skippedCount: number,
  mainFilesInstalled: number,
  totalGroundzeroFiles: number,
  mainFileConflicts: string[],
  platformResult: { platforms: string[]; created: string[] },
  ideTemplateResult: { cursor: string[]; claude: string[]; skipped: string[]; directoriesCreated: string[] },
  options: InstallOptions,
  mainFormula?: ResolvedFormula
): void {
  const cwd = process.cwd();
  
  console.log(`\n✓ Formula '${formulaName}' and ${resolvedFormulas.length - 1} dependencies installed`);
  console.log(`📁 Target directory: ${getAIDir(cwd)}`);
  console.log(`📦 Total formulas processed: ${resolvedFormulas.length}`);
  console.log(`✅ Installed: ${installedCount}, ⏭️ Skipped: ${skippedCount}`);
  
  if (mainFilesInstalled > 0) {
    console.log(`📄 Main formula files installed: ${mainFilesInstalled}`);
  }
  
  console.log(`📝 Total files added to ai: ${totalGroundzeroFiles}`);
  
  if (mainFileConflicts.length > 0) {
    console.log(`⚠️  Overwrote ${mainFileConflicts.length} existing main files`);
  }
  
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  if (mainFormula) {
    const dependencyType = options.dev ? DEPENDENCY_ARRAYS.DEV_FORMULAS : DEPENDENCY_ARRAYS.FORMULAS;
    console.log(`📋 Added to ${dependencyType} in .groundzero/formula.yml: ${formulaName}@${mainFormula.version}`);
  }
  
  // Platform and IDE template output
  if (platformResult.created.length > 0) {
    console.log(`📁 Created platform directories: ${platformResult.created.join(', ')}`);
  }

  if (ideTemplateResult.directoriesCreated.length > 0) {
    console.log(`📁 Created IDE directories: ${ideTemplateResult.directoriesCreated.join(', ')}`);
  }

  if (platformResult.platforms.length > 0) {
    console.log(`🎯 Detected platforms: ${platformResult.platforms.join(', ')}`);
  }

  if (ideTemplateResult.cursor.length > 0) {
    console.log(`🎯 Provided Cursor templates: ${ideTemplateResult.cursor.join(', ')}`);
  }

  if (ideTemplateResult.claude.length > 0) {
    console.log(`🤖 Provided Claude templates: ${ideTemplateResult.claude.join(', ')}`);
  }

  if (ideTemplateResult.skipped.length > 0) {
    console.log(`⏭️  Skipped existing IDE files: ${ideTemplateResult.skipped.join(', ')}`);
  }
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
        logger.warn(`User cancelled formula installation: ${error}`);
        return { shouldProceed: false, skippedFormulas: [], versionOverrides: new Map(), forceOverwriteFormulas: new Set() };
      }
    }
  }
  
  return { shouldProceed: true, skippedFormulas, versionOverrides, forceOverwriteFormulas };
}

/**
 * Install formula command implementation with recursive dependency resolution
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
  
  // Handle dry-run mode
  if (options.dryRun) {
    return await handleDryRunMode(finalResolvedFormulas, formulaName, targetDir, options);
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
  
  // Update formula.yml and manage platforms in parallel
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  const [formulaYmlExists, platformResult] = await Promise.all([
    exists(formulaYmlPath),
    detectAndManagePlatforms(cwd, options)
  ]);
  
  if (formulaYmlExists && mainFormula) {
    await addFormulaToYml(cwd, formulaName, mainFormula.version, options.dev || false, version);
  }
  
  // Provide IDE-specific template files
  const ideTemplateResult = await provideIdeTemplateFiles(cwd, platformResult.platforms, options);
  
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
    platformResult,
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
 */
export function setupInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Install formulas from local registry to codebase at cwd. Supports versioning with formula@version syntax.')
    .argument('[formula-name]', 'name of the formula to install (optional - installs all from formula.yml if not specified). Supports formula@version syntax.')
    .argument('[target-dir]', 'target directory relative to cwd/ai (defaults to formula name)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--force', 'overwrite existing files')
    .option('--dev', 'add formula to dev-formulas instead of formulas')
    .action(withErrorHandling(async (formulaName: string | undefined, targetDir: string, options: InstallOptions) => {
      const result = await installCommand(formulaName, targetDir, options);
      if (!result.success) {
        throw new Error(result.error || 'Install operation failed');
      }
    }));
}

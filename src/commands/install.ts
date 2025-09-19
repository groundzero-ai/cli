import { Command } from 'commander';
import { join } from 'path';
import * as semver from 'semver';
import { InstallOptions, CommandResult, FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { getInstalledFormulaVersion } from '../core/groundzero.js';
import { resolveDependencies, displayDependencyTree, promptOverwrite, ResolvedFormula } from '../core/dependency-resolver.js';
import { promptDirectoryOverwrite, promptPlatformSelection } from '../utils/prompts.js';
import { writeTextFile, exists, ensureDir } from '../utils/fs.js';
import { CURSOR_TEMPLATES, CLAUDE_TEMPLATES, Platform } from '../utils/embedded-templates.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';

/**
 * Detect existing platforms and manage platform configuration
 */
async function detectAndManagePlatforms(
  targetDir: string,
  options: InstallOptions
): Promise<{ platforms: string[]; created: string[] }> {
  const cursorDir = join(targetDir, '.cursor');
  const claudeDir = join(targetDir, '.claude');
  const formulaYmlPath = join(targetDir, 'formula.yml');
  
  const detectedPlatforms: string[] = [];
  const created: string[] = [];
  
  // Auto-detect existing platforms
  if (await exists(cursorDir)) {
    detectedPlatforms.push('cursor');
  }
  if (await exists(claudeDir)) {
    detectedPlatforms.push('claude');
  }
  
  // Check formula.yml for existing platforms configuration
  let formulaConfig: FormulaYml | null = null;
  let shouldPrompt = false;
  
  if (await exists(formulaYmlPath)) {
    try {
      formulaConfig = await parseFormulaYml(formulaYmlPath);
      
      // Prompt only if platforms field doesn't exist AND no platforms detected
      shouldPrompt = (
        formulaConfig.platforms === undefined && detectedPlatforms.length === 0
      );
    } catch (error) {
      logger.warn(`Failed to parse formula.yml: ${error}`);
      shouldPrompt = detectedPlatforms.length === 0;
    }
  } else {
    // No formula.yml - prompt only if no platforms detected
    shouldPrompt = detectedPlatforms.length === 0;
  }
  
  // Determine final platforms
  let finalPlatforms: string[];
  
  if (formulaConfig && formulaConfig.platforms !== undefined) {
    // Use existing platforms from formula.yml
    finalPlatforms = formulaConfig.platforms;
    logger.debug(`Using existing platforms from formula.yml: ${finalPlatforms.join(', ')}`);
  } else if (detectedPlatforms.length > 0) {
    // Use auto-detected platforms
    finalPlatforms = detectedPlatforms;
    logger.info(`Auto-detected platforms: ${finalPlatforms.join(', ')}`);
  } else if (shouldPrompt) {
    // Prompt user for platforms
    console.log('\n🤖 Platform Detection');
    console.log('No AI development platform detected in this project.');
    
    const selectedPlatforms = await promptPlatformSelection();
    finalPlatforms = selectedPlatforms;
    
    // Create directories for selected platforms
    for (const platform of selectedPlatforms) {
      if (platform === 'cursor' && !(await exists(cursorDir))) {
        await ensureDir(cursorDir);
        await ensureDir(join(cursorDir, 'rules'));
        created.push('.cursor');
        logger.info('Created .cursor directory structure');
      }
      if (platform === 'claude' && !(await exists(claudeDir))) {
        await ensureDir(claudeDir);
        created.push('.claude');
        logger.info('Created .claude directory');
      }
    }
  } else {
    // Fallback to empty platforms
    finalPlatforms = [];
  }
  
  // Update formula.yml with final platforms (only if platforms field didn't exist before)
  if (formulaConfig && formulaConfig.platforms === undefined && finalPlatforms.length >= 0) {
    formulaConfig.platforms = finalPlatforms;
    await writeFormulaYml(formulaYmlPath, formulaConfig);
    logger.debug(`Updated formula.yml platforms: ${finalPlatforms.join(', ')}`);
  }
  
  return { platforms: finalPlatforms, created };
}

/**
 * Provide IDE-specific template files based on detected platforms
 */
async function provideIdeTemplateFiles(
  targetDir: string,
  platforms: string[],
  options: InstallOptions
): Promise<{ cursor: string[]; claude: string[]; skipped: string[]; directoriesCreated: string[] }> {
  const cursorDir = join(targetDir, '.cursor');
  const claudeDir = join(targetDir, '.claude');
  const cursorRulesDir = join(cursorDir, 'rules');
  
  const provided: { cursor: string[]; claude: string[]; skipped: string[]; directoriesCreated: string[] } = { 
    cursor: [], 
    claude: [], 
    skipped: [], 
    directoriesCreated: [] 
  };
  
  // Provide Cursor templates if cursor platform is configured
  if (platforms.includes('cursor')) {
    logger.info('Providing Cursor IDE templates');
    
    // Check if .cursor directory needs to be created
    const cursorDirExists = await exists(cursorDir);
    if (!cursorDirExists) {
      provided.directoriesCreated.push('.cursor');
    }
    
    // Ensure .cursor/rules directory exists (create if missing)
    await ensureDir(cursorRulesDir);
    
    // Add groundzero.mdc to .cursor/rules
    const groundzeroPath = join(cursorRulesDir, 'groundzero.mdc');
    
    if (await exists(groundzeroPath) && !options.force) {
      provided.skipped.push('.cursor/rules/groundzero.mdc');
    } else {
      await writeTextFile(groundzeroPath, CURSOR_TEMPLATES['groundzero.mdc']);
      provided.cursor.push('groundzero.mdc');
      logger.debug(`Provided cursor template: groundzero.mdc`);
    }
  }
  
  // Provide Claude templates if claude platform is configured  
  if (platforms.includes('claude')) {
    logger.info('Providing Claude Code templates');
    
    // Check if .claude directory needs to be created
    const claudeDirExists = await exists(claudeDir);
    if (!claudeDirExists) {
      provided.directoriesCreated.push('.claude');
    }
    
    // Ensure .claude directory exists (create if missing)
    await ensureDir(claudeDir);
    
    // Add groundzero.md to .claude directory
    const groundzeroPath = join(claudeDir, 'groundzero.md');
    
    if (await exists(groundzeroPath) && !options.force) {
      provided.skipped.push('.claude/groundzero.md');
    } else {
      await writeTextFile(groundzeroPath, CLAUDE_TEMPLATES['groundzero.md']);
      provided.claude.push('groundzero.md');
      logger.debug(`Provided claude template: groundzero.md`);
    }
  }
  
  return provided;
}

/**
 * Find where a formula currently exists in formula.yml
 */
async function findFormulaLocation(
  formulaYmlPath: string,
  formulaName: string
): Promise<'formulas' | 'dev-formulas' | null> {
  if (!(await exists(formulaYmlPath))) {
    return null;
  }
  
  try {
    const config = await parseFormulaYml(formulaYmlPath);
    
    // Check in formulas array
    if (config.formulas?.some(dep => dep.name === formulaName)) {
      return 'formulas';
    }
    
    // Check in dev-formulas array
    if (config['dev-formulas']?.some(dep => dep.name === formulaName)) {
      return 'dev-formulas';
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
  formulaYmlPath: string, 
  formulaName: string, 
  formulaVersion: string, 
  isDev: boolean = false
): Promise<void> {
  let config: FormulaYml;
  
  if (await exists(formulaYmlPath)) {
    config = await parseFormulaYml(formulaYmlPath);
  } else {
    // If no formula.yml exists, ignore this step as per requirements
    return;
  }
  
  const dependency: FormulaDependency = {
    name: formulaName,
    version: formulaVersion
  };
  
  // Find current location of the formula
  const currentLocation = await findFormulaLocation(formulaYmlPath, formulaName);
  
  // Determine target location based on current location and --dev option
  let targetArray: 'formulas' | 'dev-formulas';
  
  if (currentLocation === 'dev-formulas' && !isDev) {
    // Case 2: Formula exists in dev-formulas but --dev not specified, keep in dev-formulas
    targetArray = 'dev-formulas';
    logger.info(`Keeping formula in dev-formulas: ${formulaName}@${formulaVersion}`);
  } else if (currentLocation === 'formulas' && isDev) {
    // Case 3: Formula exists in formulas but --dev specified, move to dev-formulas
    targetArray = 'dev-formulas';
    logger.info(`Moving formula from formulas to dev-formulas: ${formulaName}@${formulaVersion}`);
  } else {
    // Default case: use --dev option to determine placement
    targetArray = isDev ? 'dev-formulas' : 'formulas';
  }
  
  // Initialize arrays if they don't exist
  if (!config.formulas) {
    config.formulas = [];
  }
  if (!config['dev-formulas']) {
    config['dev-formulas'] = [];
  }
  
  // Remove from current location if moving between arrays
  if (currentLocation && currentLocation !== targetArray) {
    const currentIndex = config[currentLocation]!.findIndex(dep => dep.name === formulaName);
    if (currentIndex >= 0) {
      config[currentLocation]!.splice(currentIndex, 1);
    }
  }
  
  // Check if formula already exists in the target array
  const existingIndex = config[targetArray]!.findIndex(dep => dep.name === formulaName);
  
  if (existingIndex >= 0) {
    // Update existing dependency
    config[targetArray]![existingIndex] = dependency;
    logger.info(`Updated existing formula dependency: ${formulaName}@${formulaVersion}`);
  } else {
    // Add new dependency
    config[targetArray]!.push(dependency);
    logger.info(`Added new formula dependency: ${formulaName}@${formulaVersion}`);
  }
  
  await writeFormulaYml(formulaYmlPath, config);
}

/**
 * Install formula files to ai/formulaName directory
 */
async function installFormulaToGroundzero(
  formulaName: string,
  targetDir: string,
  options: InstallOptions
): Promise<{ installedCount: number; files: string[]; overwritten: boolean; skipped: boolean }> {
  const groundzeroPath = join(targetDir, 'ai');
  const formulaGroundzeroPath = join(groundzeroPath, formulaName);
  
  await ensureDir(groundzeroPath);
  
  // Load the formula from local registry first to get the version
  const formula = await formulaManager.loadFormula(formulaName);
  const newVersion = formula.metadata.version;
  
  // Check if formula directory already exists and compare versions
  let overwritten = false;
  let skipped = false;
  
  if (await exists(formulaGroundzeroPath)) {
    const installedVersion = await getInstalledFormulaVersion(formulaName, targetDir);
    
    if (installedVersion) {
      const comparison = semver.compare(newVersion, installedVersion);
      
      if (comparison > 0) {
        // New version is greater - proceed with installation (will prompt in actual execution)
        if (options.dryRun) {
          overwritten = true;
        } else {
          const shouldOverwrite = await promptOverwrite(formulaName, installedVersion, newVersion);
          if (!shouldOverwrite) {
            return {
              installedCount: 0,
              files: [],
              overwritten: false,
              skipped: true
            };
          }
          overwritten = true;
        }
      } else {
        // Same or older version - skip installation
        logger.debug(`Skipping ${formulaName}@${newVersion} (installed: v${installedVersion})`);
        return {
          installedCount: 0,
          files: [],
          overwritten: false,
          skipped: true
        };
      }
    } else {
      // Existing directory but no valid formula.yml - treat as overwrite case
      if (options.dryRun) {
        overwritten = true;
      } else {
        const shouldOverwrite = await promptDirectoryOverwrite(formulaName);
        
        if (!shouldOverwrite) {
          return {
            installedCount: 0,
            files: [],
            overwritten: false,
            skipped: true
          };
        }
        overwritten = true;
      }
    }
  }
  
  // Include MD files AND formula.yml in the installation
  const filesToInstall = formula.files.filter(file => 
    file.path.endsWith('.md') || file.path === 'formula.yml'
  );
  
  const installedFiles: string[] = [];
  
  if (!options.dryRun) {
    await ensureDir(formulaGroundzeroPath);
    
    for (const file of filesToInstall) {
      // Keep original filename (including formula.yml as non-hidden file)
      const targetFileName = file.path;
      const targetPath = join(formulaGroundzeroPath, targetFileName);
      await writeTextFile(targetPath, file.content);
      installedFiles.push(targetFileName);
      logger.debug(`Installed file to ai/${formulaName}: ${targetFileName}`);
    }
  } else {
    // For dry run, show the original filenames
    installedFiles.push(...filesToInstall.map(f => f.path));
  }
  
  return {
    installedCount: filesToInstall.length,
    files: installedFiles,
    overwritten,
    skipped
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
  
  // Parse template variables from --set options
  const variables: Record<string, any> = {};
  for (const setOption of options.set) {
    const [key, ...valueParts] = setOption.split('=');
    if (!key || valueParts.length === 0) {
      throw new ValidationError(`Invalid --set option: ${setOption}. Use format: key=value`);
    }
    variables[key.trim()] = valueParts.join('=').trim();
  }
  
  // Merge with options.variables if provided
  Object.assign(variables, options.variables || {});
  
  // Validate required template variables
  if (formula.metadata.templateVariables) {
    for (const templateVar of formula.metadata.templateVariables) {
      if (templateVar.required && !(templateVar.name in variables)) {
        if (templateVar.default !== undefined) {
          variables[templateVar.name] = templateVar.default;
        } else {
          throw new ValidationError(
            `Required template variable '${templateVar.name}' is missing. ` +
            `Use --set ${templateVar.name}=value to provide it.`
          );
        }
      }
    }
  }
  
  // Prepare installation plan - exclude formula.yml and MD files
  const installPlan = formula.files
    .filter(file => file.path !== 'formula.yml')
    .filter(file => !file.path.endsWith('.md'))
    .map(file => {
      const targetPath = join(targetDir, file.path);
      let content = file.content;
      
      // Apply template variables if this is a template file
      if (file.isTemplate && Object.keys(variables).length > 0) {
        content = formulaManager.applyTemplateVariables(content, variables);
      }
      
      return {
        sourcePath: file.path,
        targetPath,
        content,
        exists: false,
        isTemplate: file.isTemplate
      };
    });
  
  // Check for existing files
  for (const item of installPlan) {
    item.exists = await exists(item.targetPath);
  }
  
  const conflicts = installPlan.filter(item => item.exists);
  
  // Handle conflicts
  if (conflicts.length > 0 && !options.force) {
    console.log(`⚠️  The following files already exist and would be overwritten:`);
    for (const conflict of conflicts) {
      console.log(`   • ${conflict.targetPath}`);
    }
    console.log('');
    console.log('   Use --force to overwrite existing files.');
    
    throw new ValidationError('Files would be overwritten - use --force to continue');
  }
  
  // Perform actual installation
  let installedCount = 0;
  
  for (const item of installPlan) {
    try {
      await ensureDir(join(item.targetPath, '..'));
      await writeTextFile(item.targetPath, item.content);
      installedCount++;
      logger.debug(`Installed file: ${item.targetPath}`);
    } catch (error) {
      logger.error(`Failed to install file: ${item.targetPath}`, { error });
      throw new ValidationError(`Failed to install file ${item.targetPath}: ${error}`);
    }
  }
  
  return {
    installedCount,
    conflicts: conflicts.map(c => c.targetPath)
  };
}

/**
 * Install all formulas from CWD formula.yml file
 */
async function installAllFormulasCommand(
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  logger.info(`Installing all formulas from formula.yml to: ${targetDir}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // 1. Read CWD formula.yml to get list of formulas to install
  const formulaYmlPath = join(targetDir, 'formula.yml');
  
  if (!(await exists(formulaYmlPath))) {
    return { success: false, error: 'formula.yml file not found' };
  }
  
  let cwdConfig: FormulaYml;
  try {
    cwdConfig = await parseFormulaYml(formulaYmlPath);
  } catch (error) {
    throw new Error(`Failed to parse formula.yml: ${error}`);
  }
  
  const formulasToInstall: Array<{ name: string; isDev: boolean }> = [];
  
  // Add production formulas
  for (const formula of cwdConfig.formulas || []) {
    formulasToInstall.push({ name: formula.name, isDev: false });
  }
  
  // Add dev formulas
  for (const formula of cwdConfig['dev-formulas'] || []) {
    formulasToInstall.push({ name: formula.name, isDev: true });
  }
  
  if (formulasToInstall.length === 0) {
    console.log('📦 No formulas found in formula.yml');
    console.log('');
    console.log('Tips:');
    console.log('• Add formulas to the "formulas" array in formula.yml');
    console.log('• Add development formulas to the "dev-formulas" array in formula.yml');
    console.log('• Use "g0 install <formula-name>" to install a specific formula');
    
    return { success: true, data: { installed: 0, skipped: 0 } };
  }
  
  console.log(`📦 Installing ${formulasToInstall.length} formulas from formula.yml:`);
  for (const formula of formulasToInstall) {
    const prefix = formula.isDev ? '[dev] ' : '';
    console.log(`  • ${prefix}${formula.name}`);
  }
  console.log('');
  
  // 2. Install each formula individually
  let totalInstalled = 0;
  let totalSkipped = 0;
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  
  for (const formula of formulasToInstall) {
    try {
      console.log(`\n🔧 Installing ${formula.isDev ? '[dev] ' : ''}${formula.name}...`);
      
      const installOptions: InstallOptions = {
        ...options,
        dev: formula.isDev
      };
      
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
  
  // 3. Display summary
  console.log(`\n📊 Installation Summary:`);
  console.log(`✅ Successfully installed: ${totalInstalled}/${formulasToInstall.length} formulas`);
  
  if (totalSkipped > 0) {
    console.log(`❌ Failed to install: ${totalSkipped} formulas`);
    console.log('\nFailed formulas:');
    for (const result of results.filter(r => !r.success)) {
      console.log(`  • ${result.name}: ${result.error}`);
    }
  }
  
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
  
  // Otherwise install the specific formula
  return await installFormulaCommand(formulaName, targetDir, options);
}

/**
 * Install formula command implementation with recursive dependency resolution
 */
async function installFormulaCommand(
  formulaName: string,
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  logger.info(`Installing formula '${formulaName}' with dependencies to: ${targetDir}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // 1. Resolve complete dependency tree (always recursive now)
  const resolvedFormulas = await resolveDependencies(formulaName, targetDir, true);
  
  // 2. Display dependency tree
  displayDependencyTree(resolvedFormulas);
  
  // 3. Handle dry-run mode  
  if (options.dryRun) {
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
      if (resolved.conflictResolution === 'skipped') {
        console.log(`⏭️  Would skip ${resolved.name}@${resolved.version} (user would decline overwrite)`);
        continue;
      }
      
      if (resolved.conflictResolution === 'kept') {
        console.log(`⏭️  Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
        continue;
      }
      
      const dryRunResult = await installFormulaToGroundzero(resolved.name, targetDir, options);
      
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
    const formulaYmlPath = join(targetDir, 'formula.yml');
    if (await exists(formulaYmlPath)) {
      console.log(`\n📋 Would add to formula.yml: ${formulaName}@${resolvedFormulas.find(f => f.isRoot)?.version}`);
    } else {
      console.log('\nNo formula.yml found - skipping dependency addition');
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
  
  // 4. Install all resolved formulas to ai (flattened)
  let installedCount = 0;
  let skippedCount = 0;
  const groundzeroResults: Array<{ name: string; filesInstalled: number; overwritten: boolean }> = [];
  
  for (const resolved of resolvedFormulas) {
    if (resolved.conflictResolution === 'skipped') {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (user declined overwrite)`);
      continue;
    }
    
    if (resolved.conflictResolution === 'kept') {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    const groundzeroResult = await installFormulaToGroundzero(resolved.name, targetDir, options);
    
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
    
    if (resolved.conflictResolution === 'overwritten' || groundzeroResult.overwritten) {
      console.log(`🔄 Overwritten ${resolved.name}@${resolved.version} in ai`);
    }
  }
  
  // 5. Install main formula files to target directory (non-MD, non-formula.yml files)
  const mainFormula = resolvedFormulas.find(f => f.isRoot);
  let mainFilesInstalled = 0;
  let mainFileConflicts: string[] = [];
  
  if (mainFormula) {
    const mainResult = await installMainFormulaFiles(mainFormula, targetDir, options);
    mainFilesInstalled = mainResult.installedCount;
    mainFileConflicts = mainResult.conflicts;
  }
  
  // 6. Update formula.yml with direct dependencies only
  const formulaYmlPath = join(targetDir, 'formula.yml');
  if (await exists(formulaYmlPath) && mainFormula) {
    await addFormulaToYml(formulaYmlPath, formulaName, mainFormula.version, options.dev || false);
  }
  
  // 7. Detect and manage platform configuration
  const platformResult = await detectAndManagePlatforms(targetDir, options);

  // 8. Provide IDE-specific template files
  const ideTemplateResult = await provideIdeTemplateFiles(targetDir, platformResult.platforms, options);
  
  // 9. Success output
  console.log(`\n✓ Formula '${formulaName}' and ${resolvedFormulas.length - 1} dependencies installed`);
  console.log(`📁 Target directory: ${targetDir}`);
  console.log(`📦 Total formulas processed: ${resolvedFormulas.length}`);
  console.log(`✅ Installed: ${installedCount}, ⏭️ Skipped: ${skippedCount}`);
  
  if (mainFilesInstalled > 0) {
    console.log(`📄 Main formula files installed: ${mainFilesInstalled}`);
  }
  
  let totalGroundzeroFiles = 0;
  for (const result of groundzeroResults) {
    totalGroundzeroFiles += result.filesInstalled;
    if (result.overwritten) {
      console.log(`⚠️  Overwrote existing ai/${result.name} directory`);
    }
  }
  console.log(`📝 Total files added to ai: ${totalGroundzeroFiles}`);
  
  if (mainFileConflicts.length > 0) {
    console.log(`⚠️  Overwrote ${mainFileConflicts.length} existing main files`);
  }
  
  if (await exists(formulaYmlPath) && mainFormula) {
    const dependencyType = options.dev ? 'dev-formulas' : 'formulas';
    console.log(`📋 Added to ${dependencyType}: ${formulaName}@${mainFormula.version}`);
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
  
  return {
    success: true,
    data: {
      formulaName,
      targetDir,
      resolvedFormulas,
      totalFormulas: resolvedFormulas.length,
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
    .description('Install formulas from local registry to current directory')
    .argument('[formula-name]', 'name of the formula to install (optional - installs all from formula.yml if not specified)')
    .argument('[target-dir]', 'target directory (defaults to current directory)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--set <key=value>', 'set template variables', [])
    .option('--force', 'overwrite existing files')
    .option('--dev', 'add formula to dev-formulas instead of formulas')
    .action(withErrorHandling(async (formulaName: string | undefined, targetDir: string, options: InstallOptions) => {
      const result = await installCommand(formulaName, targetDir, options);
      if (!result.success) {
        throw new Error(result.error || 'Install operation failed');
      }
    }));
}

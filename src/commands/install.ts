import { Command } from 'commander';
import { join } from 'path';
import * as yaml from 'js-yaml';
import prompts from 'prompts';
import { InstallOptions, CommandResult, FormulaYml, FormulaDependency } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { writeTextFile, exists, ensureDir, readTextFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';

/**
 * Parse formula.yml file
 */
async function parseFormulaYml(formulaYmlPath: string): Promise<FormulaYml> {
  try {
    const content = await readTextFile(formulaYmlPath);
    const parsed = yaml.load(content) as FormulaYml;
    
    // Validate required fields
    if (!parsed.name || !parsed.version) {
      throw new Error('formula.yml must contain name and version fields');
    }
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse formula.yml: ${error}`);
  }
}

/**
 * Write formula.yml file
 */
async function writeFormulaYml(formulaYmlPath: string, config: FormulaYml): Promise<void> {
  const content = yaml.dump(config, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false
  });
  
  await writeTextFile(formulaYmlPath, content);
}

/**
 * Add a formula dependency to formula.yml
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
  
  const targetArray = isDev ? 'dev-formulas' : 'formulas';
  
  // Initialize array if it doesn't exist
  if (!config[targetArray]) {
    config[targetArray] = [];
  }
  
  // Check if formula already exists in the array
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
 * Install formula files to groundzero/formulaName directory
 */
async function installFormulaToGroundzero(
  formulaName: string,
  targetDir: string,
  options: InstallOptions
): Promise<{ installedCount: number; files: string[]; overwritten: boolean }> {
  const groundzeroPath = join(targetDir, 'groundzero');
  const formulaGroundzeroPath = join(groundzeroPath, formulaName);
  
  await ensureDir(groundzeroPath);
  
  // Check if formula directory already exists
  let overwritten = false;
  if (await exists(formulaGroundzeroPath)) {
    if (options.dryRun) {
      // In dry run, just note that it would be overwritten
      overwritten = true;
    } else {
      // Prompt for confirmation
      const { shouldOverwrite } = await prompts({
        type: 'confirm',
        name: 'shouldOverwrite',
        message: `Formula directory '${formulaName}' already exists in groundzero. Overwrite?`,
        initial: false
      });
      
      if (!shouldOverwrite) {
        throw new ValidationError(`Installation cancelled - formula directory '${formulaName}' already exists`);
      }
      overwritten = true;
    }
  }
  
  // Load the formula from local registry
  const formula = await formulaManager.loadFormula(formulaName);
  
  // Include MD files AND formula.yml in the installation
  const filesToInstall = formula.files.filter(file => 
    file.path.endsWith('.md') || file.path === 'formula.yml'
  );
  
  const installedFiles: string[] = [];
  
  if (!options.dryRun) {
    await ensureDir(formulaGroundzeroPath);
    
    for (const file of filesToInstall) {
      // Rename formula.yml to .formula.yml (hidden file)
      const targetFileName = file.path === 'formula.yml' ? '.formula.yml' : file.path;
      const targetPath = join(formulaGroundzeroPath, targetFileName);
      await writeTextFile(targetPath, file.content);
      installedFiles.push(targetFileName);
      logger.debug(`Installed file to groundzero/${formulaName}: ${targetFileName}`);
    }
  } else {
    // For dry run, show the correct target filenames
    installedFiles.push(...filesToInstall.map(f => 
      f.path === 'formula.yml' ? '.formula.yml' : f.path
    ));
  }
  
  return {
    installedCount: filesToInstall.length,
    files: installedFiles,
    overwritten
  };
}

/**
 * Install formula command implementation
 */
async function installFormulaCommand(
  formulaName: string,
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  logger.info(`Installing formula '${formulaName}' to: ${targetDir}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Load the formula
  const formula = await formulaManager.loadFormula(formulaName);
  const { metadata, files } = formula;
  
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
  if (metadata.templateVariables) {
    for (const templateVar of metadata.templateVariables) {
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
  
  // Prepare installation plan - exclude formula.yml as we handle it separately
  const installPlan = files
    .filter(file => file.path !== 'formula.yml') // Don't install formula.yml to target directory
    .filter(file => !file.path.endsWith('.md')) // Don't install MD files to target directory (they go to groundzero)
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
        exists: false, // Will be determined later
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
    
    return {
      success: false,
      error: 'Files would be overwritten - use --force to continue'
    };
  }
  
  // Dry run mode
  if (options.dryRun) {
    console.log(`🔍 Dry run - showing what would be installed:`);
    console.log('');
    console.log(`Formula: ${metadata.name} v${metadata.version}`);
    if (metadata.description) {
      console.log(`Description: ${metadata.description}`);
    }
    console.log('');
    
    if (Object.keys(variables).length > 0) {
      console.log('Template variables:');
      for (const [key, value] of Object.entries(variables)) {
        console.log(`  • ${key} = ${value}`);
      }
      console.log('');
    }
    
    if (installPlan.length > 0) {
      console.log('Files to be created:');
      for (const item of installPlan) {
        const status = item.exists ? (options.force ? ' (would overwrite)' : ' (already exists)') : '';
        const template = item.isTemplate ? ' [template]' : '';
        console.log(`  • ${item.targetPath}${template}${status}`);
      }
      console.log('');
    }
    
    // Show formula files that would be added to groundzero
    const dryRunGroundzeroResult = await installFormulaToGroundzero(formulaName, targetDir, options);
    if (dryRunGroundzeroResult.installedCount > 0) {
      console.log(`Files to be added to groundzero/${formulaName}:`);
      for (const file of dryRunGroundzeroResult.files) {
        console.log(`  • groundzero/${formulaName}/${file}`);
      }
      if (dryRunGroundzeroResult.overwritten) {
        console.log(`  ⚠️  Would overwrite existing directory`);
      }
      console.log('');
    }
    
    // Show formula.yml update
    const formulaYmlPath = join(targetDir, 'formula.yml');
    if (await exists(formulaYmlPath)) {
      const dependencyType = options.dev ? 'dev-formulas' : 'formulas';
      console.log(`Would add to ${dependencyType}: ${formulaName}@${metadata.version}`);
    } else {
      console.log('No formula.yml found - skipping dependency addition');
    }
    
    return {
      success: true,
      data: { 
        dryRun: true, 
        plan: installPlan, 
        groundzeroFiles: dryRunGroundzeroResult.installedCount,
        wouldOverwrite: dryRunGroundzeroResult.overwritten
      }
    };
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
  
  // Install formula files to groundzero directory
  const groundzeroResult = await installFormulaToGroundzero(formulaName, targetDir, options);
  
  // Add formula to formula.yml if it exists
  const formulaYmlPath = join(targetDir, 'formula.yml');
  try {
    await addFormulaToYml(formulaYmlPath, formulaName, metadata.version, options.dev || false);
  } catch (error) {
    logger.warn(`Failed to update formula.yml: ${error}`);
  }
  
  // Success output
  console.log(`✓ Formula '${formulaName}' installed successfully`);
  console.log(`📁 Target directory: ${targetDir}`);
  if (installedCount > 0) {
    console.log(`📄 Files installed: ${installedCount}`);
  }
  console.log(`📝 Files added to groundzero/${formulaName}: ${groundzeroResult.installedCount}`);
  
  if (await exists(formulaYmlPath)) {
    const dependencyType = options.dev ? 'dev-formulas' : 'formulas';
    console.log(`📋 Added to ${dependencyType}: ${formulaName}@${metadata.version}`);
  }
  
  if (Object.keys(variables).length > 0) {
    console.log(`🔧 Template variables applied: ${Object.keys(variables).join(', ')}`);
  }
  
  if (conflicts.length > 0) {
    console.log(`⚠️  Overwrote ${conflicts.length} existing files`);
  }
  
  if (groundzeroResult.overwritten) {
    console.log(`⚠️  Overwrote existing groundzero/${formulaName} directory`);
  }
  
  return {
    success: true,
    data: {
      formulaName,
      targetDir,
      filesInstalled: installedCount,
      variables,
      overwroteFiles: conflicts.length,
      groundzeroFiles: groundzeroResult.installedCount,
      addedToFormulaYml: await exists(formulaYmlPath),
      groundzeroOverwritten: groundzeroResult.overwritten
    }
  };
}

/**
 * Setup the install command
 */
export function setupInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Install a formula from local registry to current directory')
    .argument('<formula-name>', 'name of the formula to install')
    .argument('[target-dir]', 'target directory (defaults to current directory)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--set <key=value>', 'set template variables', [])
    .option('--force', 'overwrite existing files')
    .option('--dev', 'add formula to dev-formulas instead of formulas')
    .action(withErrorHandling(async (formulaName: string, targetDir: string, options: InstallOptions) => {
      const result = await installFormulaCommand(formulaName, targetDir, options);
      if (!result.success) {
        throw new Error(result.error || 'Install operation failed');
      }
    }));
}

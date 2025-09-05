import { Command } from 'commander';
import { join } from 'path';
import { InstallOptions, CommandResult } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { writeTextFile, exists, ensureDir } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';

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
  
  // Prepare installation plan
  const installPlan = files.map(file => {
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
    
    console.log('Files to be created:');
    for (const item of installPlan) {
      const status = item.exists ? (options.force ? ' (would overwrite)' : ' (already exists)') : '';
      const template = item.isTemplate ? ' [template]' : '';
      console.log(`  • ${item.targetPath}${template}${status}`);
    }
    
    return {
      success: true,
      data: { dryRun: true, plan: installPlan }
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
  
  // Success output
  console.log(`✓ Formula '${formulaName}' installed successfully`);
  console.log(`📁 Target directory: ${targetDir}`);
  console.log(`📄 Files installed: ${installedCount}/${files.length}`);
  
  if (Object.keys(variables).length > 0) {
    console.log(`🔧 Template variables applied: ${Object.keys(variables).join(', ')}`);
  }
  
  if (conflicts.length > 0) {
    console.log(`⚠️  Overwrote ${conflicts.length} existing files`);
  }
  
  return {
    success: true,
    data: {
      formulaName,
      targetDir,
      filesInstalled: installedCount,
      variables,
      overwroteFiles: conflicts.length
    }
  };
}

/**
 * Setup the install command
 */
export function setupInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Apply a formula to a directory')
    .argument('<formula-name>', 'name of the formula to install')
    .argument('[target-dir]', 'target directory (defaults to current directory)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--set <key=value>', 'set template variables', [])
    .option('--force', 'overwrite existing files')
    .action(withErrorHandling(async (formulaName: string, targetDir: string, options: InstallOptions) => {
      const result = await installFormulaCommand(formulaName, targetDir, options);
      if (!result.success) {
        throw new Error(result.error || 'Install operation failed');
      }
    }));
}

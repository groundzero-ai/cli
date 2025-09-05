import { Command } from 'commander';
import { CreateOptions, CommandResult } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';

/**
 * Create formula command implementation
 */
async function createFormulaCommand(
  formulaName: string,
  sourceDir: string,
  options: CreateOptions
): Promise<CommandResult> {
  logger.info(`Creating formula '${formulaName}' from directory: ${sourceDir}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Create the formula
  const formula = await formulaManager.createFormula(formulaName, sourceDir, options);
  
  // Success output
  console.log(`✓ Formula '${formulaName}' created successfully`);
  console.log(`📦 Version: ${formula.metadata.version}`);
  if (formula.metadata.description) {
    console.log(`📝 Description: ${formula.metadata.description}`);
  }
  console.log(`📁 Files: ${formula.files.length} files included`);
  if (formula.metadata.templateVariables && formula.metadata.templateVariables.length > 0) {
    console.log(`🔧 Template variables: ${formula.metadata.templateVariables.map(v => v.name).join(', ')}`);
  }
  
  return {
    success: true,
    data: formula.metadata
  };
}

/**
 * Setup the create command
 */
export function setupCreateCommand(program: Command): void {
  program
    .command('create')
    .description('Create a new formula from a directory')
    .argument('<formula-name>', 'name of the formula to create')
    .argument('[source-dir]', 'source directory (defaults to current directory)', '.')
    .option('-d, --description <desc>', 'formula description')
    .option('-v, --version <version>', 'formula version', '1.0.0')
    .option('--exclude <patterns>', 'comma-separated patterns to exclude')
    .option('-a, --author <author>', 'formula author')
    .option('-l, --license <license>', 'formula license')
    .option('-k, --keywords <keywords>', 'comma-separated keywords')
    .action(withErrorHandling(async (formulaName: string, sourceDir: string, options: CreateOptions) => {
      await createFormulaCommand(formulaName, sourceDir, options);
    }));
}

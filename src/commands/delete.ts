import { Command } from 'commander';
import { DeleteOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { formulaManager } from '../core/formula.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { promptFormulaDelete } from '../utils/prompts.js';

/**
 * Delete formula command implementation
 */
async function deleteFormulaCommand(
  formulaName: string, 
  options: DeleteOptions
): Promise<CommandResult> {
  logger.info(`Deleting formula: ${formulaName}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Check if formula exists
  if (!(await formulaManager.formulaExists(formulaName))) {
    console.log(`❌ Formula '${formulaName}' not found`);
    return { success: false, error: 'Formula not found' };
  }
  
  // Confirmation prompt (if not forced)
  if (!options.force) {
    const shouldDelete = await promptFormulaDelete(formulaName);
    
    // Handle user cancellation (Ctrl+C or 'n')
    if (!shouldDelete) {
      throw new UserCancellationError();
    }
  }
  
  // Delete the formula using formula manager
  try {
    await formulaManager.deleteFormula(formulaName);
    
    console.log(`✓ Formula '${formulaName}' deleted successfully`);
    
    return {
      success: true,
      data: { formulaName }
    };
  } catch (error) {
    logger.error(`Failed to delete formula: ${formulaName}`, { error });
    throw new Error(`Failed to delete formula: ${error}`);
  }
}

/**
 * Setup the delete command
 */
export function setupDeleteCommand(program: Command): void {
  program
    .command('delete')
    .alias('del')
    .description('Delete a formula from local registry')
    .argument('<formula-name>', 'name of the formula to delete')
    .option('-f, --force', 'skip confirmation prompt')
    .action(withErrorHandling(async (formulaName: string, options: DeleteOptions) => {
      const result = await deleteFormulaCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Delete operation failed');
      }
    }));
}

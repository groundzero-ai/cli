import { Command } from 'commander';
import { DeleteOptions, CommandResult } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';

/**
 * Delete formula command implementation
 */
async function deleteFormulaCommand(
  formulaName: string, 
  options: DeleteOptions
): Promise<CommandResult> {
  logger.info(`Deleting formula: ${formulaName}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Check if formula exists
  const exists = await formulaManager.formulaExists(formulaName);
  if (!exists) {
    console.log(`❌ Formula '${formulaName}' not found`);
    return { success: false, error: 'Formula not found' };
  }
  
  // Confirmation prompt (if not forced)
  if (!options.force) {
    console.log(`⚠️  This will permanently delete the formula '${formulaName}' from your local registry.`);
    console.log('   Use --force to skip this confirmation.');
    console.log('');
    console.log(`   To continue, please run: g0 delete ${formulaName} --force`);
    
    return {
      success: false,
      error: 'Operation cancelled - use --force to confirm deletion'
    };
  }
  
  // Delete the formula
  await formulaManager.deleteFormula(formulaName);
  
  console.log(`✓ Formula '${formulaName}' deleted successfully`);
  
  return {
    success: true,
    data: { formulaName }
  };
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
    .option('--force', 'skip confirmation prompt')
    .action(withErrorHandling(async (formulaName: string, options: DeleteOptions) => {
      const result = await deleteFormulaCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Delete operation failed');
      }
    }));
}

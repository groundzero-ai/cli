import { Command } from 'commander';
import { ListOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { registryManager } from '../core/registry.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { displayFormulaTable, FormulaTableEntry } from '../utils/formatters.js';

/**
 * List formulas command implementation
 */
async function listFormulasCommand(options: ListOptions): Promise<CommandResult> {
  logger.info('Listing local formulas');
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    // Use registry manager to list formulas
    const entries = await registryManager.listFormulas(options.filter, options.all);
    
    if (entries.length === 0) {
      if (options.filter) {
        console.log(`No formulas found matching filter: ${options.filter}`);
      } else {
        console.log('No formulas found. Use "g0 init" to create your first formula.');
      }
      return { success: true, data: [] };
    }
    
    // Display results
    if (options.format === 'json') {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      // Table format using shared formatter
      const tableEntries: FormulaTableEntry[] = entries.map(entry => ({
        name: entry.name,
        version: entry.version,
        description: entry.description
      }));
      
      const title = options.all ? 'Local formulas (all versions):' : 'Local formulas:';
      displayFormulaTable(tableEntries, title, options.all);
    }
    
    return {
      success: true,
      data: entries
    };
  } catch (error) {
    logger.error('Failed to list formulas', { error });
    throw new Error(`Failed to list formulas: ${error}`);
  }
}


/**
 * Setup the list command
 */
export function setupListCommand(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('List local formulas')
    .option('--format <format>', 'output format (table|json)', 'table')
    .option('--filter <pattern>', 'filter formulas by name pattern')
    .option('--all', 'show all versions (default shows only latest)')
    .action(withErrorHandling(async (options: ListOptions) => {
      await listFormulasCommand(options);
    }));
}

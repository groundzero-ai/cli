import { Command } from 'commander';
import { ListOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { registryManager } from '../core/registry.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { displayFormulaTable, FormulaTableEntry } from '../utils/formatters.js';
import { areFormulaNamesEquivalent } from '../utils/formula-name.js';

/**
 * List formulas command implementation
 */
async function listFormulasCommand(options: ListOptions): Promise<CommandResult> {
  logger.info('Listing local formulas');
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    // If formula name is provided, use exact matching; otherwise use filter
    const filter = options.formulaName || options.filter;
    // When formula name is specified, show all versions automatically
    const showAllVersions = options.formulaName ? true : options.all;
    const entries = await registryManager.listFormulas(filter, showAllVersions);
    
    // If a specific formula name was provided, filter for exact matches only
    let filteredEntries = entries;
    if (options.formulaName) {
      const target =options.formulaName;
      filteredEntries = entries.filter(entry => areFormulaNamesEquivalent(entry.name, target));
    }
    
    if (filteredEntries.length === 0) {
      if (options.formulaName) {
        console.log(`Formula not found: ${options.formulaName}`);
      } else if (options.filter) {
        console.log(`No formulas found matching filter: ${options.filter}`);
      } else {
        console.log('No formulas found. Use "opn init" to create your first formula.');
      }
      return { success: true, data: [] };
    }
    
    // Display results
    if (options.format === 'json') {
      console.log(JSON.stringify(filteredEntries, null, 2));
    } else {
      // Table format using shared formatter
      const tableEntries: FormulaTableEntry[] = filteredEntries.map(entry => ({
        name: entry.name,
        version: entry.version,
        description: entry.description
      }));
      
      let title: string;
      if (options.formulaName) {
        title = `Formula '${options.formulaName}' (all versions):`;
      } else {
        title = options.all ? 'Local formulas (all versions):' : 'Local formulas (latest versions):';
      }
      
      displayFormulaTable(tableEntries, title, showAllVersions);
    }
    
    return {
      success: true,
      data: filteredEntries
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
    .command('list [formula-name]')
    .alias('ls')
    .description('List local formulas or show all versions of specific formula if name provided')
    .option('--format <format>', 'output format (table|json)', 'table')
    .option('--filter <pattern>', 'filter formulas by name pattern')
    .option('--all', 'show all versions (default shows only latest)')
    .action(withErrorHandling(async (formulaName: string | undefined, options: ListOptions) => {
      options.formulaName = formulaName;
      await listFormulasCommand(options);
    }));
}

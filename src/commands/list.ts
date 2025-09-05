import { Command } from 'commander';
import { ListOptions, CommandResult } from '../types/index.js';
import { registryManager } from '../core/registry.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';

/**
 * List formulas command implementation
 */
async function listFormulasCommand(options: ListOptions): Promise<CommandResult> {
  logger.info('Listing local formulas', { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Get formulas
  const formulas = await registryManager.listFormulas(options.filter);
  
  if (formulas.length === 0) {
    if (options.filter) {
      console.log(`No formulas found matching filter: ${options.filter}`);
    } else {
      console.log('No formulas found. Use "g0 create" to create your first formula.');
    }
    return { success: true, data: [] };
  }
  
  // Display results
  if (options.format === 'json') {
    console.log(JSON.stringify(formulas, null, 2));
  } else {
    // Table format
    console.log('Local formulas:');
    console.log('');
    console.log('NAME'.padEnd(20) + 'VERSION'.padEnd(12) + 'DESCRIPTION');
    console.log('----'.padEnd(20) + '-------'.padEnd(12) + '-----------');
    
    for (const formula of formulas) {
      const name = formula.name.padEnd(20);
      const version = formula.version.padEnd(12);
      const description = formula.description || '(no description)';
      console.log(`${name}${version}${description}`);
    }
    
    console.log('');
    console.log(`Total: ${formulas.length} formulas`);
  }
  
  return {
    success: true,
    data: formulas
  };
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
    .action(withErrorHandling(async (options: ListOptions) => {
      await listFormulasCommand(options);
    }));
}

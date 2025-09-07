import { Command } from 'commander';
import { SearchOptions, CommandResult } from '../types/index.js';
import { registryManager } from '../core/registry.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { displayFormulaTable, FormulaTableEntry } from '../utils/formatters.js';

/**
 * Search formulas command implementation
 */
async function searchFormulasCommand(
  term: string,
  options: SearchOptions
): Promise<CommandResult> {
  logger.info(`Searching formulas with term: ${term}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  const limit = parseInt(options.limit, 10);
  if (isNaN(limit) || limit < 1) {
    console.error('❌ Invalid limit value. Must be a positive number.');
    return { success: false, error: 'Invalid limit value' };
  }
  
  // Search local registry
  const searchResult = await registryManager.searchFormulas(term, limit);
  
  // Display results
  console.log(`🔍 Search results for: "${term}"`);
  console.log('');
  
  if (searchResult.entries.length === 0) {
    console.log('No formulas found matching your search term.');
    console.log('');
    console.log('Tips:');
    console.log('• Try using different or fewer keywords');
    console.log('• Check for typos in your search term');
    console.log('• Use "g0 list" to see all available formulas');
    
    return { success: true, data: searchResult };
  }
  
  // Table format using shared formatter
  const tableEntries: FormulaTableEntry[] = searchResult.entries.map(entry => ({
    name: entry.name,
    version: entry.version,
    description: entry.description
  }));
  
  // Display results without title since we already have the search header
  if (tableEntries.length === 0) {
    console.log('No formulas found.');
    return { success: true, data: searchResult };
  }
  
  // Table header
  console.log('NAME'.padEnd(20) + 'VERSION'.padEnd(12) + 'DESCRIPTION');
  console.log('----'.padEnd(20) + '-------'.padEnd(12) + '-----------');
  
  // Display each result
  for (const entry of tableEntries) {
    const name = entry.name.padEnd(20);
    const version = entry.version.padEnd(12);
    const description = entry.description || '(no description)';
    console.log(`${name}${version}${description}`);
  }
  
  console.log('');
  
  // Search summary
  if (searchResult.total > searchResult.entries.length) {
    console.log(`Showing ${searchResult.entries.length} of ${searchResult.total} results (use --limit to see more)`);
  } else {
    console.log(`Found ${searchResult.total} formulas matching your search`);
  }
  
  return {
    success: true,
    data: searchResult
  };
}

/**
 * Setup the search command
 */
export function setupSearchCommand(program: Command): void {
  program
    .command('search')
    .description('Search formulas in local registry')
    .argument('<term>', 'search term')
    .option('--limit <number>', 'limit number of results', '10')
    .action(withErrorHandling(async (term: string, options: SearchOptions) => {
      const result = await searchFormulasCommand(term, options);
      if (!result.success) {
        throw new Error(result.error || 'Search operation failed');
      }
    }));
}

import { Command } from 'commander';
import { join } from 'path';
import { ListOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories, getRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { displayFormulaTable, FormulaTableEntry } from '../utils/formatters.js';
import { 
  listFiles, 
  readJsonFile, 
  exists 
} from '../utils/fs.js';

/**
 * List formulas command implementation
 */
async function listFormulasCommand(options: ListOptions): Promise<CommandResult> {
  logger.info('Listing local formulas');
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Get metadata directory
  const { metadata: metadataDir } = getRegistryDirectories();
  
  if (!(await exists(metadataDir))) {
    logger.debug('Metadata directory does not exist, returning empty list');
    console.log('No formulas found. Use "g0 init" to create your first formula.');
    return { success: true, data: [] };
  }
  
  // Read metadata files directly (aligned with create command structure)
  const metadataFiles = await listFiles(metadataDir);
  const formulas: Array<{
    name: string;
    version: string;
    description?: string;
    keywords?: string[];
    private?: boolean;
    dependencies?: Array<{ name: string; version: string }>;
    devDependencies?: Array<{ name: string; version: string }>;
    updated: string;
  }> = [];
  
  for (const file of metadataFiles) {
    if (!file.endsWith('.json')) continue;
    
    try {
      const metadataPath = join(metadataDir, file);
      const metadata = await readJsonFile(metadataPath);
      
      // Apply filter if provided
      if (options.filter && !matchesFilter(metadata.name, options.filter)) {
        continue;
      }
      
      formulas.push({
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        keywords: metadata.keywords || [],
        private: metadata.private || false,
        dependencies: metadata.dependencies || [],
        devDependencies: metadata.devDependencies || [],
        updated: metadata.updated
      });
    } catch (error) {
      logger.warn(`Failed to read metadata file: ${file}`, { error });
    }
  }
  
  if (formulas.length === 0) {
    if (options.filter) {
      console.log(`No formulas found matching filter: ${options.filter}`);
    } else {
      console.log('No formulas found. Use "g0 init" to create your first formula.');
    }
    return { success: true, data: [] };
  }
  
  // Sort by name
  formulas.sort((a, b) => a.name.localeCompare(b.name));
  
  // Display results
  if (options.format === 'json') {
    console.log(JSON.stringify(formulas, null, 2));
  } else {
    // Table format using shared formatter
    const tableEntries: FormulaTableEntry[] = formulas.map(formula => ({
      name: formula.name,
      version: formula.version,
      description: formula.description
    }));
    
    displayFormulaTable(tableEntries, 'Local formulas:');
  }
  
  return {
    success: true,
    data: formulas
  };
}

/**
 * Simple pattern matching for filtering
 */
function matchesFilter(name: string, filter: string): boolean {
  // Convert simple glob pattern to regex
  const pattern = filter
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    .toLowerCase();
  
  const regex = new RegExp(`^${pattern}$`);
  return regex.test(name.toLowerCase());
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

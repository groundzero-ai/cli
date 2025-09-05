import { Command } from 'commander';
import { join } from 'path';
import { CommandResult, FormulaStatus } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { exists, readJsonFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';

/**
 * Status command implementation - shows applied formulas in a directory
 */
async function statusCommand(targetDir: string): Promise<CommandResult> {
  logger.info(`Checking formula status for directory: ${targetDir}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Look for a .g0-formulas.json file in the target directory
  const statusFile = join(targetDir, '.g0-formulas.json');
  const hasStatusFile = await exists(statusFile);
  
  const appliedFormulas: FormulaStatus[] = [];
  
  if (hasStatusFile) {
    try {
      const statusData = await readJsonFile<{
        formulas: Array<{
          name: string;
          version: string;
          installedAt: string;
          variables?: Record<string, any>;
        }>;
      }>(statusFile);
      
      for (const formula of statusData.formulas) {
        appliedFormulas.push({
          name: formula.name,
          version: formula.version,
          status: 'installed',
          installedAt: formula.installedAt
        });
      }
    } catch (error) {
      logger.warn('Failed to read status file', { error, statusFile });
    }
  }
  
  // Display results
  console.log(`📁 Formula status for directory: ${targetDir}`);
  console.log('');
  
  if (appliedFormulas.length === 0) {
    console.log('No formulas detected in this directory.');
    console.log('');
    console.log('Tips:');
    console.log('• Use "g0 install <formula-name>" to apply a formula to this directory');
    console.log('• Use "g0 list" to see available formulas');
    
    return { success: true, data: [] };
  }
  
  // Table header
  console.log('FORMULA'.padEnd(20) + 'VERSION'.padEnd(12) + 'STATUS'.padEnd(15) + 'INSTALLED');
  console.log('-------'.padEnd(20) + '-------'.padEnd(12) + '------'.padEnd(15) + '---------');
  
  // Display each formula
  for (const formula of appliedFormulas) {
    const name = formula.name.padEnd(20);
    const version = formula.version.padEnd(12);
    const status = formula.status.padEnd(15);
    const installedAt = formula.installedAt ? 
      new Date(formula.installedAt).toLocaleDateString() : 
      'unknown';
    
    console.log(`${name}${version}${status}${installedAt}`);
  }
  
  console.log('');
  console.log(`Total: ${appliedFormulas.length} formulas applied`);
  
  return {
    success: true,
    data: appliedFormulas
  };
}

/**
 * Setup the status command
 */
export function setupStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show applied formulas in a directory')
    .argument('[target-dir]', 'target directory (defaults to current directory)', '.')
    .action(withErrorHandling(async (targetDir: string) => {
      await statusCommand(targetDir);
    }));
}

import { basename } from 'path';
import { isJunk } from 'junk';
import { Command } from 'commander';
import { CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, FormulaNotFoundError } from '../utils/errors.js';
import { describeVersionRange, isExactVersion } from '../utils/version-ranges.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { formulaManager } from '../core/formula.js';

/**
 * Show formula details command implementation (supports formula@version)
 */
async function showFormulaCommand(formulaInput: string): Promise<CommandResult> {
  logger.debug(`Showing details for formula input: ${formulaInput}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    // Parse input (supports name@version or name@range)
    const { name, version } = parseFormulaInput(formulaInput);
    
    // Load formula (resolves ranges to a specific version)
    const formula = await formulaManager.loadFormula(name, version);
    const metadata = formula.metadata;
    const files = formula.files;
    
    // Display formula details
    console.log(`🍺 Formula: ${metadata.name}`);
    
    console.log(`📦 Version: ${metadata.version}`);
    if (metadata.description) {
      console.log(`📝 Description: ${metadata.description}`);
    }
    if (metadata.keywords && metadata.keywords.length > 0) {
      console.log(`🏷️  Keywords: ${metadata.keywords.join(', ')}`);
    }
    console.log(`🔒 Private: ${metadata.private ? 'Yes' : 'No'}`);
    
    // Dependencies section
    if (metadata.formulas && metadata.formulas.length > 0) {
      console.log(`📋 Dependencies (${metadata.formulas.length}):`);
      for (const dep of metadata.formulas) {
        const rangeDescription = !isExactVersion(dep.version) 
          ? ` (${describeVersionRange(dep.version)})`
          : '';
        console.log(`  • ${dep.name}@${dep.version}${rangeDescription}`);
      }
    }
    
    if (metadata['dev-formulas'] && metadata['dev-formulas'].length > 0) {
      console.log(`🔧 Dev Dependencies (${metadata['dev-formulas'].length}):`);
      for (const dep of metadata['dev-formulas']) {
        const rangeDescription = !isExactVersion(dep.version) 
          ? ` (${describeVersionRange(dep.version)})`
          : '';
        console.log(`  • ${dep.name}@${dep.version}${rangeDescription}`);
      }
    }
    
    // Files section - match install command's file list format
    const filteredFiles = files.filter(f => !isJunk(basename(f.path)));
    const sortedFilePaths = filteredFiles.map(f => f.path).sort((a, b) => a.localeCompare(b));
    console.log(`📝 Files: ${sortedFilePaths.length}`);
    for (const filePath of sortedFilePaths) {
      console.log(`   ├── ${filePath}`);
    }
    console.log('');
    
    return {
      success: true,
      data: metadata
    };
  } catch (error) {
    // Align with other commands' UX for not found
    if (error instanceof FormulaNotFoundError) {
      return { success: false, error: `Formula '${formulaInput}' not found` };
    }
    throw new Error(`Failed to show formula: ${error}`);
  }
}


/**
 * Setup the show command
 */
export function setupShowCommand(program: Command): void {
  program
    .command('show')
    .description('Show details of a formula. Supports versioning with formula@version syntax.')
    .argument('<formula-name>', 'name of the formula to show. Supports formula@version syntax.')
    .action(withErrorHandling(async (formulaInput: string) => {
      await showFormulaCommand(formulaInput);
    }));
}

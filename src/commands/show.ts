import { Command } from 'commander';
import { CommandResult } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';

/**
 * Show formula details command implementation
 */
async function showFormulaCommand(formulaName: string): Promise<CommandResult> {
  logger.info(`Showing details for formula: ${formulaName}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Load the formula
  const formula = await formulaManager.loadFormula(formulaName);
  const { metadata, files } = formula;
  
  // Display formula details
  console.log(`Formula: ${metadata.name}`);
  console.log('='.repeat(20 + metadata.name.length));
  console.log('');
  
  console.log(`📦 Version: ${metadata.version}`);
  if (metadata.description) {
    console.log(`📝 Description: ${metadata.description}`);
  }
  if (metadata.author) {
    console.log(`👤 Author: ${metadata.author}`);
  }
  if (metadata.license) {
    console.log(`📄 License: ${metadata.license}`);
  }
  if (metadata.keywords && metadata.keywords.length > 0) {
    console.log(`🏷️  Keywords: ${metadata.keywords.join(', ')}`);
  }
  
  console.log(`📅 Created: ${new Date(metadata.created).toLocaleString()}`);
  console.log(`📅 Updated: ${new Date(metadata.updated).toLocaleString()}`);
  console.log('');
  
  // Files section
  console.log(`📁 Files (${files.length}):`);
  console.log('');
  
  const templateFiles = files.filter(f => f.isTemplate);
  const regularFiles = files.filter(f => !f.isTemplate);
  
  if (templateFiles.length > 0) {
    console.log('  📋 Template files:');
    for (const file of templateFiles) {
      console.log(`    • ${file.path}`);
    }
    console.log('');
  }
  
  if (regularFiles.length > 0) {
    console.log('  📄 Regular files:');
    for (const file of regularFiles) {
      console.log(`    • ${file.path}`);
    }
    console.log('');
  }
  
  // Template variables section
  if (metadata.templateVariables && metadata.templateVariables.length > 0) {
    console.log(`🔧 Template Variables (${metadata.templateVariables.length}):`);
    console.log('');
    
    for (const variable of metadata.templateVariables) {
      const required = variable.required ? '(required)' : '(optional)';
      const defaultValue = variable.default !== undefined ? ` [default: ${variable.default}]` : '';
      console.log(`  • ${variable.name} (${variable.type}) ${required}${defaultValue}`);
      if (variable.description) {
        console.log(`    ${variable.description}`);
      }
    }
    console.log('');
  }
  
  // Exclude patterns section
  if (metadata.excludePatterns && metadata.excludePatterns.length > 0) {
    console.log('🚫 Excluded patterns:');
    for (const pattern of metadata.excludePatterns) {
      console.log(`  • ${pattern}`);
    }
    console.log('');
  }
  
  return {
    success: true,
    data: metadata
  };
}

/**
 * Setup the show command
 */
export function setupShowCommand(program: Command): void {
  program
    .command('show')
    .description('Show details of a formula')
    .argument('<formula-name>', 'name of the formula to show')
    .action(withErrorHandling(async (formulaName: string) => {
      await showFormulaCommand(formulaName);
    }));
}

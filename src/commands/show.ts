import { Command } from 'commander';
import { join } from 'path';
import { CommandResult } from '../types/index.js';
import { ensureRegistryDirectories, getFormulaPath, getFormulaMetadataPath } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { exists, readJsonFile, readTextFile } from '../utils/fs.js';
import { detectTemplateFile } from '../utils/template.js';

/**
 * Show formula details command implementation
 */
async function showFormulaCommand(formulaName: string): Promise<CommandResult> {
  logger.info(`Showing details for formula: ${formulaName}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Check if formula exists (aligned with create command structure)
  const metadataPath = getFormulaMetadataPath(formulaName);
  const formulaPath = getFormulaPath(formulaName);
  
  if (!(await exists(metadataPath))) {
    console.log(`❌ Formula '${formulaName}' not found`);
    return { success: false, error: 'Formula not found' };
  }
  
  try {
    // Load metadata directly (aligned with create command structure)
    const metadata = await readJsonFile(metadataPath);
    
    // Load files from formula directory
    const files: Array<{
      path: string;
      content: string;
      isTemplate: boolean;
    }> = [];
    
    for (const filePath of metadata.files || []) {
      const fullPath = join(formulaPath, filePath);
      if (await exists(fullPath)) {
        const content = await readTextFile(fullPath);
        const isTemplate = detectTemplateFile(content);
        
        files.push({
          path: filePath,
          content,
          isTemplate
        });
      } else {
        logger.warn(`Formula file missing: ${filePath}`, { formulaName, filePath });
      }
    }
    
    // Display formula details
    console.log(`Formula: ${metadata.name}`);
    console.log('='.repeat(20 + metadata.name.length));
    console.log('');
    
    console.log(`📦 Version: ${metadata.version}`);
    if (metadata.description) {
      console.log(`📝 Description: ${metadata.description}`);
    }
    if (metadata.keywords && metadata.keywords.length > 0) {
      console.log(`🏷️  Keywords: ${metadata.keywords.join(', ')}`);
    }
    if (metadata.private) {
      console.log(`🔒 Private: Yes`);
    }
    
    console.log(`📅 Created: ${new Date(metadata.created).toLocaleString()}`);
    console.log(`📅 Updated: ${new Date(metadata.updated).toLocaleString()}`);
    console.log('');
    
    // Dependencies section
    if (metadata.dependencies && metadata.dependencies.length > 0) {
      console.log(`📋 Dependencies (${metadata.dependencies.length}):`);
      for (const dep of metadata.dependencies) {
        console.log(`  • ${dep.name}@${dep.version}`);
      }
      console.log('');
    }
    
    if (metadata.devDependencies && metadata.devDependencies.length > 0) {
      console.log(`🔧 Dev Dependencies (${metadata.devDependencies.length}):`);
      for (const dep of metadata.devDependencies) {
        console.log(`  • ${dep.name}@${dep.version}`);
      }
      console.log('');
    }
    
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
    
    return {
      success: true,
      data: metadata
    };
  } catch (error) {
    logger.error(`Failed to show formula: ${formulaName}`, { error });
    throw new Error(`Failed to show formula: ${error}`);
  }
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

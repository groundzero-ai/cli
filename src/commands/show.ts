import { Command } from 'commander';
import { join, basename } from 'path';
import { isNotJunk } from 'junk';
import { CommandResult } from '../types/index.js';
import { ensureRegistryDirectories, getLatestFormulaVersion, getFormulaVersionPath } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { readTextFile, walkFiles } from '../utils/fs.js';
import { detectTemplateFile } from '../utils/template.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { describeVersionRange, isExactVersion } from '../utils/version-ranges.js';

/**
 * Show formula details command implementation
 */
async function showFormulaCommand(formulaName: string): Promise<CommandResult> {
  logger.debug(`Showing details for formula: ${formulaName}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Check if formula exists and get the latest version
  const latestVersion = await getLatestFormulaVersion(formulaName);
  
  if (!latestVersion) {
    console.log(`❌ Formula '${formulaName}' not found`);
    return { success: false, error: 'Formula not found' };
  }
  
  const formulaVersionPath = getFormulaVersionPath(formulaName, latestVersion);
  const formulaYmlPath = join(formulaVersionPath, 'formula.yml');
  
  try {
    // Load metadata from formula.yml
    const metadata = await parseFormulaYml(formulaYmlPath);
    
    // Discover all files in the formula directory
    const files: Array<{
      path: string;
      content: string;
      isTemplate: boolean;
    }> = [];
    
    for await (const fullPath of walkFiles(formulaVersionPath)) {
      const fileName = basename(fullPath);
      if (!isNotJunk(fileName)) {
        continue;
      }
      const relativePath = fullPath.replace(formulaVersionPath + '/', '');
      const content = await readTextFile(fullPath);
      const isTemplate = detectTemplateFile(content);
      
      files.push({
        path: relativePath,
        content,
        isTemplate
      });
    }
    
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
    const sortedFilePaths = files.map(f => f.path).sort((a, b) => a.localeCompare(b));
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

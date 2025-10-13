import { logger } from './logger.js';
import { ValidationError } from './errors.js';
import { parseVersionRange } from './version-ranges.js';
import { promptPlatformSelection } from './prompts.js';
import { detectAllPlatforms } from '../core/platforms.js';

/**
 * Parse formula input to extract name and version/range
 */
export function parseFormulaInput(formulaInput: string): { name: string; version?: string } {
  const atIndex = formulaInput.lastIndexOf('@');

  if (atIndex === -1) {
    return { name: formulaInput };
  }

  const name = formulaInput.substring(0, atIndex);
  const version = formulaInput.substring(atIndex + 1);

  if (!name || !version) {
    throw new ValidationError(`Invalid formula syntax: ${formulaInput}. Use format: formula@version or formula@range`);
  }

  // Validate the version/range format
  try {
    parseVersionRange(version);
  } catch (error) {
    throw new ValidationError(`Invalid version/range format: ${version}. ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return { name, version };
}

/**
 * Detect existing platforms in the project
 */
export async function detectPlatforms(targetDir: string): Promise<string[]> {
  const platformDetectionResults = await detectAllPlatforms(targetDir);
  const detectedPlatforms = platformDetectionResults
    .filter(result => result.detected)
    .map(result => result.name);

  if (detectedPlatforms.length > 0) {
    logger.debug(`Auto-detected platforms: ${detectedPlatforms.join(', ')}`);
  }

  return detectedPlatforms;
}

/**
 * Prompt user for platform selection when no platforms are detected
 */
export async function promptForPlatformSelection(): Promise<string[]> {
  console.log('\n🤖 Platform Detection');
  console.log('No AI development platform detected in this project.');

  return await promptPlatformSelection();
}

/**
 * Display installation summary
 */
export function displayInstallationSummary(
  totalInstalled: number,
  totalSkipped: number,
  totalFormulas: number,
  results: Array<{ name: string; success: boolean; error?: string }>
): void {
  console.log(`\n📊 Installation Summary:`);
  console.log(`✅ Successfully installed: ${totalInstalled}/${totalFormulas} formulas`);

  if (totalSkipped > 0) {
    console.log(`❌ Failed to install: ${totalSkipped} formulas`);
    console.log('\nFailed formulas:');
    results.filter(r => !r.success).forEach(result => {
      console.log(`  • ${result.name}: ${result.error}`);
    });
  }
}

/**
 * Display installation results
 */
export function displayInstallationResults(
  formulaName: string,
  resolvedFormulas: any[],
  platformResult: { platforms: string[]; created: string[] },
  ideTemplateResult: { filesAdded: string[]; skipped: string[]; directoriesCreated: string[] },
  options: any,
  mainFormula?: any,
  allAddedFiles?: string[],
  allUpdatedFiles?: string[],
  rootFileResults?: { installed: string[]; updated: string[]; skipped: string[] }
): void {
  // Build installation summary
  let summaryText = `✓ Installed ${formulaName}`;
  if (mainFormula) {
    summaryText += `@${mainFormula.version}`;
  }

  const dependencyFormulas = resolvedFormulas.filter(f => !f.isRoot);
  if (dependencyFormulas.length > 0) {
    const dependencyVersions = dependencyFormulas.map(f => `${f.name}@${f.version}`).join(', ');
    summaryText += ` and dependencies: ${dependencyVersions}`;
  } else {
    summaryText += ` and ${resolvedFormulas.length - 1} dependencies`;
  }

  console.log(`\n${summaryText}`);
  console.log(`📦 Total formulas processed: ${resolvedFormulas.length}`);

  // Show detailed file list
  if (allAddedFiles && allAddedFiles.length > 0) {
    console.log(`📝 Added files: ${allAddedFiles.length}`);
    const sortedFiles = [...allAddedFiles].sort((a, b) => a.localeCompare(b));
    for (const file of sortedFiles) {
      console.log(`   ├── ${file}`);
    }
  }

  if (allUpdatedFiles && allUpdatedFiles.length > 0) {
    console.log(`🔄 Updated files: ${allUpdatedFiles.length}`);
    const sortedFiles = [...allUpdatedFiles].sort((a, b) => a.localeCompare(b));
    for (const file of sortedFiles) {
      console.log(`   ├── ${file}`);
    }
  }

  // Root file installation results
  if (rootFileResults) {
    const totalRootFiles = rootFileResults.installed.length + rootFileResults.updated.length;
    if (totalRootFiles > 0) {
      console.log(`📄 Root files: ${totalRootFiles} file(s)`);
      
      // Show newly created root files
      if (rootFileResults.installed.length > 0) {
        const sortedInstalled = [...rootFileResults.installed].sort((a, b) => a.localeCompare(b));
        for (const file of sortedInstalled) {
          console.log(`   ├── ${file} (created)`);
        }
      }
      
      // Show updated root files
      if (rootFileResults.updated.length > 0) {
        const sortedUpdated = [...rootFileResults.updated].sort((a, b) => a.localeCompare(b));
        for (const file of sortedUpdated) {
          console.log(`   ├── ${file} (updated)`);
        }
      }
    }
  }

  // Platform and IDE template output
  if (platformResult.created.length > 0) {
    console.log(`📁 Created platform directories: ${platformResult.created.join(', ')}`);
  }

  if (ideTemplateResult.directoriesCreated.length > 0) {
    console.log(`📁 Created IDE directories: ${ideTemplateResult.directoriesCreated.join(', ')}`);
  }
}

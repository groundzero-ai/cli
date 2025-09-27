import { exists } from './fs.js';
import { logger } from './logger.js';
import { ValidationError } from './errors.js';
import { parseVersionRange } from './version-ranges.js';
import { promptPlatformSelection } from './prompts.js';
import { detectAllPlatforms } from '../core/platforms.js';
import { getAIDir, getLocalFormulaYmlPath } from './paths.js';

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
    logger.info(`Auto-detected platforms: ${detectedPlatforms.join(', ')}`);
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
  installedCount: number,
  skippedCount: number,
  mainFilesInstalled: number,
  totalGroundzeroFiles: number,
  mainFileConflicts: string[],
  platformResult: { platforms: string[]; created: string[] },
  ideTemplateResult: { filesAdded: string[]; skipped: string[]; directoriesCreated: string[] },
  options: any,
  mainFormula?: any
): void {
  const cwd = process.cwd();

  console.log(`\n✓ Formula '${formulaName}' and ${resolvedFormulas.length - 1} dependencies installed`);
  console.log(`📁 Target directory: ${getAIDir(cwd)}`);
  console.log(`📦 Total formulas processed: ${resolvedFormulas.length}`);
  console.log(`✅ Installed: ${installedCount}, ⏭️ Skipped: ${skippedCount}`);

  if (mainFilesInstalled > 0) {
    console.log(`📄 Main formula files installed: ${mainFilesInstalled}`);
  }

  console.log(`📝 Total files added to ai: ${totalGroundzeroFiles}`);

  if (mainFileConflicts.length > 0) {
    console.log(`⚠️  Overwrote ${mainFileConflicts.length} existing main files`);
  }

  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  if (mainFormula) {
    const dependencyType = options.dev ? 'dev-formulas' : 'formulas';
    console.log(`📋 Added to ${dependencyType} in .groundzero/formula.yml: ${formulaName}@${mainFormula.version}`);
  }

  // Platform and IDE template output
  if (platformResult.created.length > 0) {
    console.log(`📁 Created platform directories: ${platformResult.created.join(', ')}`);
  }

  if (ideTemplateResult.directoriesCreated.length > 0) {
    console.log(`📁 Created IDE directories: ${ideTemplateResult.directoriesCreated.join(', ')}`);
  }

  if (platformResult.platforms.length > 0) {
    console.log(`🎯 Detected platforms: ${platformResult.platforms.join(', ')}`);
  }

  if (ideTemplateResult.filesAdded.length > 0) {
    console.log(`📝 Added groundzero.md files: ${ideTemplateResult.filesAdded.join(', ')}`);
  }

  if (ideTemplateResult.skipped.length > 0) {
    console.log(`⏭️  Skipped existing IDE files: ${ideTemplateResult.skipped.join(', ')}`);
  }
}

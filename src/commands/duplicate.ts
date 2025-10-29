import { Command } from 'commander';
import * as semver from 'semver';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, FormulaNotFoundError } from '../utils/errors.js';
import { Formula, CommandResult } from '../types/index.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { transformFormulaFilesForDuplication } from '../utils/formula-versioning.js';
import { isRootFile } from '../core/save/root-files-sync.js';

async function duplicateFormulaCommand(
  sourceInput: string,
  newInput: string
): Promise<CommandResult> {
  logger.info(`Duplicating formula: ${sourceInput} -> ${newInput}`);

  // Ensure registry directories
  await ensureRegistryDirectories();

  // Parse inputs
  const { name: sourceName, version: sourceVersionInput } = parseFormulaInput(sourceInput);
  const { name: newName, version: newVersionInput } = parseFormulaInput(newInput);

  // Validate new version if provided
  if (newVersionInput && !semver.valid(newVersionInput)) {
    throw new Error(`Invalid version: ${newVersionInput}. Must be a valid semver version.`);
  }

  // Load source formula (handles ranges; defaults to latest)
  let sourceFormula: Formula;
  try {
    sourceFormula = await formulaManager.loadFormula(sourceName, sourceVersionInput);
  } catch (error) {
    if (error instanceof FormulaNotFoundError) {
      return { success: false, error: `Target formula ${sourceName} not found.` };
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  // Check if any version already exists for the new name
  if (await formulaManager.formulaExists(newName)) {
    return { success: false, error: `Formula ${newName} already exists` };
  }

  // Determine new version
  const newVersion = newVersionInput || sourceFormula.metadata.version;

  // Transform files: update frontmatter, formula.yml, and root file markers
  const transformedFiles = transformFormulaFilesForDuplication(
    sourceFormula.files,
    sourceName,
    newName,
    newVersion
  );

  const newFormula: Formula = {
    metadata: {
      ...sourceFormula.metadata,
      name: newName,
      version: newVersion
    },
    files: transformedFiles
  };

  // Save duplicated formula
  await formulaManager.saveFormula(newFormula);

  console.log(`✓ Duplicated '${sourceName}@${sourceFormula.metadata.version}' -> '${newName}@${newVersion}'`);

  // Count processed file types for better user feedback
  const rootFileCount = transformedFiles.filter(f => isRootFile(f.path)).length;
  const markdownFileCount = transformedFiles.filter(f =>
    FILE_PATTERNS.MARKDOWN_FILES.some(ext => f.path.endsWith(ext)) &&
    !isRootFile(f.path)
  ).length;

  if (rootFileCount > 0) {
    logger.debug(`  └─ Updated ${rootFileCount} root file marker(s) with new IDs`);
  }
  if (markdownFileCount > 0) {
    logger.debug(`  └─ Updated ${markdownFileCount} markdown file(s) with new frontmatter and IDs`);
  }

  return { success: true, data: { from: `${sourceName}@${sourceFormula.metadata.version}`, to: `${newName}@${newVersion}` } };
}

export function setupDuplicateCommand(program: Command): void {
  program
    .command('duplicate')
    .description('Duplicate a formula in the local registry to a new name and optional version')
    .argument('<formula>', 'source formula name or formula@version')
    .argument('<newName>', 'new formula name or newName@version')
    .action(withErrorHandling(async (formula: string, newName: string) => {
      const result = await duplicateFormulaCommand(formula, newName);
      if (!result.success) {
        // If we already printed a user-friendly message, just exit with error
        if (result.error) throw new Error(result.error);
      }
    }));
}



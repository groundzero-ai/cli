import { Command } from 'commander';
import * as semver from 'semver';
import yaml from 'js-yaml';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { updateMarkdownWithFormulaFrontmatter } from '../utils/md-frontmatter.js';
import { isRootFile } from '../core/save/root-files-sync.js';
import { transformRootFileContent } from '../utils/root-file-transformer.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, FormulaNotFoundError } from '../utils/errors.js';
import { Formula, FormulaFile, FormulaYml, CommandResult } from '../types/index.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { parseFormulaInput } from '../utils/formula-name.js';


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
      console.log(`Target formula ${sourceName} not found.`);
      return { success: false, error: `Target formula ${sourceName} not found.` };
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  // Check if any version already exists for the new name
  if (await formulaManager.formulaExists(newName)) {
    console.log(`Formula ${newName} already exists`);
    return { success: false, error: `Formula ${newName} already exists` };
  }

  // Determine new version
  const newVersion = newVersionInput || sourceFormula.metadata.version;

  // Transform files: update frontmatter, formula.yml, and root file markers
  const transformedFiles: FormulaFile[] = sourceFormula.files.map((file) => {
    if (file.path === FILE_PATTERNS.FORMULA_YML) {
      try {
        const parsed = yaml.load(file.content) as FormulaYml;
        const updated: FormulaYml = {
          ...parsed,
          name: newName,
          version: newVersion
        };
        const dumped = yaml.dump(updated, { lineWidth: 120 });
        return { ...file, content: dumped };
      } catch {
        // Fallback: minimal rewrite if parsing fails
        const fallback: FormulaYml = {
          name: newName,
          version: newVersion
        };
        const dumped = yaml.dump(fallback, { lineWidth: 120 });
        return { ...file, content: dumped };
      }
    }

    // Handle root files (AGENTS.md, CLAUDE.md, etc.) - update markers with new name and ID
    if (isRootFile(file.path)) {
      const updatedContent = transformRootFileContent(file.content, sourceName, newName);
      return { ...file, content: updatedContent };
    }

    // Handle regular markdown files - update frontmatter (only for non-root files)
    if (file.path.endsWith(FILE_PATTERNS.MD_FILES) || file.path.endsWith(FILE_PATTERNS.MDC_FILES)) {
      const updatedContent = updateMarkdownWithFormulaFrontmatter(file.content, { name: newName, resetId: true });
      return { ...file, content: updatedContent };
    }

    return file;
  });

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
    (f.path.endsWith(FILE_PATTERNS.MD_FILES) || f.path.endsWith(FILE_PATTERNS.MDC_FILES)) &&
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



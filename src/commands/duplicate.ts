import { Command } from 'commander';
import * as semver from 'semver';
import yaml from 'js-yaml';
import { formulaManager } from '../core/formula.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { updateMarkdownWithFormulaFrontmatter, parseMarkdownFrontmatter } from '../utils/md-frontmatter.js';
import { updateIndexYml } from '../utils/index-yml.js';
import { isRootFile } from '../core/save/root-files-sync.js';
import { transformRootFileContent } from '../utils/root-file-transformer.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, FormulaNotFoundError } from '../utils/errors.js';
import { Formula, FormulaFile, FormulaYml, CommandResult } from '../types/index.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { parseFormulaInput } from '../utils/formula-name.js';

/**
 * Helper function to dump YAML with proper quoting for scoped names
 */
function dumpYamlWithScopedQuoting(config: FormulaYml, options: yaml.DumpOptions = {}): string {
  let dumped = yaml.dump(config, { ...options, quotingType: '"' });
  
  // Ensure scoped names are quoted
  if (config.name.startsWith('@')) {
    const lines = dumped.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('name:')) {
        const valueMatch = lines[i].match(/name:\s*(.+)$/);
        if (valueMatch) {
          const value = valueMatch[1].trim();
          if (!value.startsWith('"') && !value.startsWith("'")) {
            lines[i] = lines[i].replace(/name:\s*(.+)$/, `name: "${config.name}"`);
          }
        }
        break;
      }
    }
    dumped = lines.join('\n');
  }
  
  return dumped;
}

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
  const transformedFiles: FormulaFile[] = sourceFormula.files.map((file) => {
    if (file.path === FILE_PATTERNS.FORMULA_YML) {
      try {
        const parsed = yaml.load(file.content) as FormulaYml;
        const updated: FormulaYml = {
          ...parsed,
          name: newName,
          version: newVersion
        };
        const dumped = dumpYamlWithScopedQuoting(updated, { lineWidth: 120 });
        return { ...file, content: dumped };
      } catch {
        // Fallback: minimal rewrite if parsing fails
        const fallback: FormulaYml = {
          name: newName,
          version: newVersion
        };
        const dumped = dumpYamlWithScopedQuoting(fallback, { lineWidth: 120 });
        return { ...file, content: dumped };
      }
    }

    // Handle index.yml files - update formula name
    if (file.path.endsWith(FILE_PATTERNS.INDEX_YML)) {
      const result = updateIndexYml(file.content, { name: newName });
      if (result.updated) {
        return { ...file, content: result.content };
      }
      return file;
    }

    // Handle root files (AGENTS.md, CLAUDE.md, etc.) - update markers with new name and ID
    if (isRootFile(file.path)) {
      const updatedContent = transformRootFileContent(file.content, sourceName, newName);
      return { ...file, content: updatedContent };
    }

    // Handle regular markdown files - update frontmatter only for files that already have formula frontmatter
    if (FILE_PATTERNS.MARKDOWN_FILES.some(ext => file.path.endsWith(ext))) {
      const frontmatter = parseMarkdownFrontmatter(file.content);
      const existingFormulaName = frontmatter?.formula?.name;

      if (existingFormulaName) {
        const updatedContent = updateMarkdownWithFormulaFrontmatter(file.content, { name: newName, resetId: true });
        return { ...file, content: updatedContent };
      }
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



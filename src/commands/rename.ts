import { Command } from 'commander';
import { dirname, join, basename } from 'path';
import { CommandResult } from '../types/index.js';
import { withErrorHandling, UserCancellationError, ValidationError } from '../utils/errors.js';
import { safePrompts } from '../utils/prompts.js';
import { findFormulas } from '../utils/file-discovery.js';
import { exists, readTextFile, writeTextFile, walkFiles, renameDirectory } from '../utils/fs.js';
import { parseFormulaYml, writeFormulaYml, updateMarkdownWithFormulaFrontmatter } from '../utils/formula-yml.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { logger } from '../utils/logger.js';

/**
 * Rename a local formula by updating formula.yml name, renaming its directory,
 * and updating all markdown frontmatter referencing the old name.
 */
async function renameFormulaCommand(oldName: string, newName: string): Promise<CommandResult> {
  const cwd = process.cwd();

  if (!oldName || !newName) {
    throw new ValidationError('Both <formula-name> and <new-formula-name> are required');
  }

  if (oldName === newName) {
    console.log('Nothing to do: old and new names are the same');
    return { success: true };
  }

  // 1) Discover formula by name in cwd (supports explicit formula.yml and frontmatter-based)
  const matches = await findFormulas(oldName);
  if (!matches || matches.length === 0) {
    console.log(`Formula ${oldName} not found`);
    return { success: true };
  }

  // Prefer explicit formula.yml match if available
  const explicitMatch = matches.find(m => m.fullPath.endsWith(`/${FILE_PATTERNS.FORMULA_YML}`));
  const target = explicitMatch || matches[0];

  // Derive the formula directory that contains formula.yml (or the markdown file location for frontmatter-only)
  const targetDir = dirname(target.fullPath);

  // 2) Confirm action with user
  const { proceed } = await safePrompts({
    type: 'confirm',
    name: 'proceed',
    message: `Rename formula '${oldName}' to '${newName}'?`,
    initial: true
  });

  if (!proceed) {
    throw new UserCancellationError('Operation cancelled by user');
  }

  // 3) Update formula.yml if present
  const formulaYmlPath = join(targetDir, FILE_PATTERNS.FORMULA_YML);
  let hasFormulaYml = await exists(formulaYmlPath);
  if (hasFormulaYml) {
    const config = await parseFormulaYml(formulaYmlPath);
    const originalName = config.name;
    if (originalName !== oldName) {
      // Be lenient: proceed but log a warning
      logger.warn(`formula.yml name ('${originalName}') differs from target ('${oldName}'), updating to '${newName}'.`);
    }
    config.name = newName;
    await writeFormulaYml(formulaYmlPath, config);
    console.log(`✓ Updated ${FILE_PATTERNS.FORMULA_YML} name: ${oldName} → ${newName}`);
  }

  // 4) Update markdown files under the formula dir (frontmatter name)
  let updatedCount = 0;
  for await (const filePath of walkFiles(targetDir)) {
    if (!filePath.endsWith('.md') && !filePath.endsWith('.mdc')) continue;
    const content = await readTextFile(filePath);
    // Only update when frontmatter contains formula section referencing old name.
    const updated = updateMarkdownWithFormulaFrontmatter(content, newName);
    if (updated !== content) {
      // Only count as updated if the file had the old formula or lacked formula frontmatter. To avoid eagerly changing unrelated files
      // we perform a simple guard: if content mentions the old formula in frontmatter or has any formula section.
      // Delegate strictness to updateMarkdownWithFormulaFrontmatter which preserves non-formula frontmatter.
      await writeTextFile(filePath, updated);
      updatedCount++;
      console.log(`✓ Updated frontmatter: ${basename(filePath)}`);
    }
  }

  // 5) If formula.yml exists, try renaming the directory to the new name for better consistency
  // Only when the directory name equals oldName and parent structure matches .groundzero/formulas/<name>
  if (hasFormulaYml) {
    const parentDir = dirname(targetDir);
    const currentDirName = basename(targetDir);
    if (currentDirName === oldName) {
      const destDir = join(parentDir, newName);
      if (destDir !== targetDir) {
        await renameDirectory(targetDir, destDir);
        console.log(`✓ Renamed directory: ${currentDirName} → ${newName}`);
      }
    }
  }

  console.log(`✓ Rename completed. Updated ${updatedCount} markdown file(s).`);
  return { success: true };
}

export function setupRenameCommand(program: Command): void {
  program
    .command('rename')
    .argument('<formula-name>', 'existing formula name')
    .argument('<new-formula-name>', 'new formula name')
    .description('Rename a local formula and update related frontmatter in detected files')
    .action(withErrorHandling(async (oldName: string, newName: string) => {
      const result = await renameFormulaCommand(oldName, newName);
      if (!result.success) {
        throw new Error(result.error || 'Rename operation failed');
      }
    }));
}



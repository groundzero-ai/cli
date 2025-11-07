import * as semver from 'semver';
import yaml from 'js-yaml';
import { Formula, FormulaFile, FormulaYml } from '../types/index.js';
import { extractBaseVersion } from './version-generator.js';
import { getFormulaVersionPath } from '../core/directory.js';
import { exists } from './fs.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { updateIndexYml } from './index-yml.js';
import { isRootFile } from '../core/sync/root-files-sync.js';
import { transformRootFileContent } from './root-file-transformer.js';
import { parseMarkdownFrontmatter, updateMarkdownWithFormulaFrontmatter } from './md-frontmatter.js';

/**
 * Compute stable version from a prerelease version
 * Example: "1.2.3-dev.abc123" -> "1.2.3"
 */
export function computeStableVersion(version: string): string {
  const parsed = semver.parse(version);
  if (parsed) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }
  return extractBaseVersion(version);
}

/**
 * Dump YAML with proper quoting for scoped names (e.g., @scope/name)
 */
export function dumpYamlWithScopedQuoting(config: FormulaYml, options: yaml.DumpOptions = {}): string {
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

/**
 * Transform formula files for version change only (no name change)
 * Updates formula.yml version field
 */
export function transformFormulaFilesForVersionChange(
  files: FormulaFile[],
  newVersion: string,
  formulaName: string
): FormulaFile[] {
  return files.map((file) => {
    if (file.path === FILE_PATTERNS.FORMULA_YML) {
      try {
        const parsed = yaml.load(file.content) as FormulaYml;
        const updated: FormulaYml = {
          ...parsed,
          version: newVersion
        };
        const dumped = dumpYamlWithScopedQuoting(updated, { lineWidth: 120 });
        return { ...file, content: dumped };
      } catch {
        // Fallback: minimal rewrite if parsing fails
        const fallback: FormulaYml = {
          name: formulaName,
          version: newVersion
        };
        const dumped = dumpYamlWithScopedQuoting(fallback, { lineWidth: 120 });
        return { ...file, content: dumped };
      }
    }
    return file;
  });
}

/**
 * Transform formula files metadata for name and version changes
 * Updates formula.yml, index.yml, root files, and markdown frontmatter
 */
export function transformFormulaFilesMetadata(
  files: FormulaFile[],
  sourceName: string,
  newName: string,
  newVersion: string
): FormulaFile[] {
  return files.map((file) => {
    // Update formula.yml
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
}

/**
 * Check if a formula version already exists
 */
export async function formulaVersionExists(formulaName: string, version: string): Promise<boolean> {
  const targetPath = getFormulaVersionPath(formulaName, version);
  return await exists(targetPath);
}


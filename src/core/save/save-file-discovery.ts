import { basename, dirname, join } from 'path';

import { FILE_PATTERNS } from '../../constants/index.js';
import type { FormulaFile } from '../../types/index.js';
import { exists, isDirectory, readTextFile } from '../../utils/fs.js';
import { findFilesByExtension } from '../../utils/file-processing.js';
import { getLocalFormulaDir } from '../../utils/paths.js';
import { FORMULA_INDEX_FILENAME } from '../../utils/formula-index-yml.js';
import type { FormulaYmlInfo } from './formula-yml-generator.js';
import * as yaml from 'js-yaml';
import { UTF8_ENCODING } from './constants.js';

async function createFormulaYmlFile(formulaInfo: FormulaYmlInfo): Promise<FormulaFile> {
  const formulaYmlContent = yaml.dump(formulaInfo.config, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false,
    quotingType: '"'  // Prefer double quotes for consistency
  });
  return {
    path: FILE_PATTERNS.FORMULA_YML,
    content: formulaYmlContent,
    encoding: UTF8_ENCODING
  };
}

export async function discoverFormulaFilesForSave(formulaInfo: FormulaYmlInfo): Promise<FormulaFile[]> {
  const cwd = process.cwd();
  const formulaDir = getLocalFormulaDir(cwd, formulaInfo.config.name);

  if (!(await exists(formulaDir)) || !(await isDirectory(formulaDir))) {
    return [];
  }

  const formulaFiles: FormulaFile[] = [];

  // Discover all files under the formula directory, excluding formula.index.yml
  const entries = await findFilesByExtension(formulaDir, [], formulaDir);
  const filteredEntries = entries.filter(entry => basename(entry.relativePath) !== FORMULA_INDEX_FILENAME);

  // Convert each file directly to FormulaFile
  for (const entry of filteredEntries) {
    const content = await readTextFile(entry.fullPath);
    formulaFiles.push({
      path: entry.relativePath,
      content,
      encoding: UTF8_ENCODING
    });
  }

  return formulaFiles;
}
import * as yaml from 'js-yaml';
import { FormulaYml } from '../types/index.js';
import { readTextFile, writeTextFile } from './fs.js';

/**
 * Parse formula.yml file with validation
 */
export async function parseFormulaYml(formulaYmlPath: string): Promise<FormulaYml> {
  try {
    const content = await readTextFile(formulaYmlPath);
    const parsed = yaml.load(content) as FormulaYml;
    
    // Validate required fields
    if (!parsed.name || !parsed.version) {
      throw new Error('formula.yml must contain name and version fields');
    }
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse formula.yml: ${error}`);
  }
}

/**
 * Write formula.yml file with consistent formatting
 */
export async function writeFormulaYml(formulaYmlPath: string, config: FormulaYml): Promise<void> {
  const content = yaml.dump(config, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false
  });
  
  await writeTextFile(formulaYmlPath, content);
}

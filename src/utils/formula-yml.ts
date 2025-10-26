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
  // First generate YAML with default block style
  let content = yaml.dump(config, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false,
    quotingType: '"'  // Prefer double quotes for consistency
  });
  
  // Ensure scoped names (starting with @) are quoted
  const isScopedName = config.name.startsWith('@');
  if (isScopedName) {
    // Split into lines and process the name line
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('name:')) {
        // Check if the name value is already quoted
        const valueMatch = lines[i].match(/name:\s*(.+)$/);
        if (valueMatch) {
          const value = valueMatch[1].trim();
          // If not quoted, add quotes
          if (!value.startsWith('"') && !value.startsWith("'")) {
            lines[i] = lines[i].replace(/name:\s*(.+)$/, `name: "${config.name}"`);
          }
        }
        break;
      }
    }
    content = lines.join('\n');
  }
  
  // Convert arrays from block style to flow style
  const flowStyleArrays = ['keywords'];
  
  for (const arrayField of flowStyleArrays) {
    const arrayValue = config[arrayField as keyof FormulaYml];
    if (Array.isArray(arrayValue) && arrayValue.length > 0) {
      // Split content into lines for easier processing
      const lines = content.split('\n');
      const result: string[] = [];
      let i = 0;
      
      while (i < lines.length) {
        const line = lines[i];
        
        if (line.trim() === `${arrayField}:`) {
          // Found array section, create flow style
          const arrayFlow = `${arrayField}: [${arrayValue.join(', ')}]`;
          result.push(arrayFlow);
          
          // Skip the following dash lines
          i++;
          while (i < lines.length && lines[i].trim().startsWith('-')) {
            i++;
          }
          continue;
        }
        
        result.push(line);
        i++;
      }
      
      content = result.join('\n');
    }
  }
  
  await writeTextFile(formulaYmlPath, content);
}


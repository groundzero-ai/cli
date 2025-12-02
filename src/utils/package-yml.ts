import * as yaml from 'js-yaml';
import { PackageYml } from '../types/index.js';
import { readTextFile, writeTextFile } from './fs.js';
import { isScopedName } from '../core/scoping/package-scoping.js';

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  return result.length > 0 ? result : undefined;
}

/**
 * Parse package.yml file with validation
 */
export async function parsePackageYml(packageYmlPath: string): Promise<PackageYml> {
  try {
    const content = await readTextFile(packageYmlPath);
    const parsed = yaml.load(content) as PackageYml;
    
    // Validate required fields
    if (!parsed.name || !parsed.version) {
      throw new Error('package.yml must contain name and version fields');
    }

    const includeFilters = normalizeStringArray(parsed.include);
    const excludeFilters = normalizeStringArray(parsed.exclude);
    if (includeFilters) {
      parsed.include = includeFilters;
    } else {
      delete (parsed as any).include;
    }
    if (excludeFilters) {
      parsed.exclude = excludeFilters;
    } else {
      delete (parsed as any).exclude;
    }
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse package.yml: ${error}`);
  }
}

/**
 * Write package.yml file with consistent formatting
 */
export async function writePackageYml(packageYmlPath: string, config: PackageYml): Promise<void> {
  // First generate YAML with default block style
  let content = yaml.dump(config, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false,
    quotingType: '"'  // Prefer double quotes for consistency
  });
  
  // Ensure scoped names (starting with @) are quoted
  const isScoped = isScopedName(config.name);
  if (isScoped) {
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
    const arrayValue = config[arrayField as keyof PackageYml];
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
  
  await writeTextFile(packageYmlPath, content);
}


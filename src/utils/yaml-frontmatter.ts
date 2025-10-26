import * as yaml from 'js-yaml';

/**
 * Generate a properly quoted YAML key-value pair
 */
export function generateYamlKeyValue(key: string, value: any, indent: string = ''): string {
  // For boolean values, just output as-is
  if (typeof value === 'boolean') {
    return `${indent}${key}: ${value}`;
  }

  // For strings, use js-yaml to ensure proper quoting
  if (typeof value === 'string') {
    // Check if this is a scoped name (starts with @) - these need explicit quoting
    const isScopedName = value.startsWith('@');
    
    const quotedValue = yaml.dump(value, {
      flowLevel: 0,
      quotingType: '"',  // Prefer double quotes for consistency
      forceQuotes: isScopedName  // Force quotes for scoped names
    }).trim();

    return `${indent}${key}: ${quotedValue}`;
  }

  // For other types, fallback to string conversion
  return `${indent}${key}: ${String(value)}`;
}

/**
 * Generate a complete YAML frontmatter block with proper quoting
 */
export function generateFormulaFrontmatterBlock(
  formulaData: {
    name?: string;
    id?: string;
    platformSpecific?: boolean;
  },
  indent: string = '  '
): string {
  const lines: string[] = [];

  if (formulaData.name) {
    lines.push(generateYamlKeyValue('name', formulaData.name, indent));
  }
  if (formulaData.id) {
    lines.push(generateYamlKeyValue('id', formulaData.id, indent));
  }
  if (formulaData.platformSpecific === true) {
    lines.push(`${indent}platformSpecific: true`);
  }

  return lines.join('\n');
}

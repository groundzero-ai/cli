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


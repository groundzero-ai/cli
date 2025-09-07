/**
 * Template file utilities for detecting and processing template variables
 */

/**
 * Detect if a file contains template variables
 * Template variables are in the format {{ variableName }}
 */
export function detectTemplateFile(content: string): boolean {
  return /\{\{\s*\w+\s*\}\}/.test(content);
}

/**
 * Extract template variable names from content
 */
export function extractTemplateVariables(content: string): string[] {
  const matches = content.match(/\{\{\s*(\w+)\s*\}\}/g);
  if (!matches) return [];
  
  return matches.map(match => {
    const variable = match.match(/\{\{\s*(\w+)\s*\}\}/);
    return variable ? variable[1] : '';
  }).filter(Boolean);
}

/**
 * Check if content has any template variables
 */
export function hasTemplateVariables(content: string): boolean {
  return detectTemplateFile(content);
}

/**
 * Simple template variable replacement
 * Replaces {{ variableName }} with corresponding values
 */
export function applyTemplateVariables(content: string, variables: Record<string, any>): string {
  let result = content;
  
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    result = result.replace(pattern, String(value));
  }
  
  return result;
}

/**
 * Validate that all required template variables are provided
 */
export function validateTemplateVariables(content: string, variables: Record<string, any>): string[] {
  const templateVars = extractTemplateVariables(content);
  const missing: string[] = [];
  
  for (const templateVar of templateVars) {
    if (!(templateVar in variables)) {
      missing.push(templateVar);
    }
  }
  
  return missing;
}

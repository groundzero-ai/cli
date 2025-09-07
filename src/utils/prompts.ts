import prompts from 'prompts';
import { basename } from 'path';
import { FormulaYml } from '../types/index.js';

/**
 * Common prompt types and utilities for user interaction
 */

/**
 * Prompt for simple confirmation
 */
export async function promptConfirmation(message: string, initial: boolean = false): Promise<boolean> {
  const { confirmed } = await prompts({
    type: 'confirm',
    name: 'confirmed',
    message,
    initial
  });
  
  return confirmed || false;
}

/**
 * Prompt for overwrite confirmation with specific formula context
 */
export async function promptFormulaOverwrite(formulaName: string): Promise<boolean> {
  return await promptConfirmation(
    `Formula '${formulaName}' already exists. Overwrite?`,
    false
  );
}

/**
 * Prompt for directory overwrite confirmation
 */
export async function promptDirectoryOverwrite(formulaName: string): Promise<boolean> {
  return await promptConfirmation(
    `Formula directory '${formulaName}' already exists in groundzero. Overwrite?`,
    false
  );
}

/**
 * Prompt for formula deletion confirmation
 */
export async function promptFormulaDelete(formulaName: string): Promise<boolean> {
  return await promptConfirmation(
    `Are you sure you want to delete formula '${formulaName}'? This action cannot be undone.`,
    false
  );
}

/**
 * Prompt for creating a new formula
 */
export async function promptCreateFormula(): Promise<boolean> {
  return await promptConfirmation(
    'No formula.yml found. Would you like to create a new formula?',
    true
  );
}

/**
 * Formula details prompt for interactive formula creation
 */
export async function promptFormulaDetails(defaultName?: string): Promise<FormulaYml> {
  const cwd = process.cwd();
  const suggestedName = defaultName || basename(cwd);
  
  const response = await prompts([
    {
      type: 'text',
      name: 'name',
      message: 'Formula name:',
      initial: suggestedName,
      validate: (value: string) => {
        if (!value) return 'Name is required';
        if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
          return 'Name can only contain letters, numbers, hyphens, and underscores';
        }
        return true;
      }
    },
    {
      type: 'text',
      name: 'version',
      message: 'Version:',
      initial: '0.1.0',
      validate: (value: string) => {
        if (!value) return 'Version is required';
        if (!/^\d+\.\d+\.\d+/.test(value)) {
          return 'Version should follow semantic versioning (e.g., 1.0.0)';
        }
        return true;
      }
    },
    {
      type: 'text',
      name: 'description',
      message: 'Description:'
    },
    {
      type: 'list',
      name: 'keywords',
      message: 'Keywords (comma-separated):',
      separator: ','
    },
    {
      type: 'confirm',
      name: 'private',
      message: 'Private formula?',
      initial: false
    }
  ]);
  
  // Handle user cancellation
  if (!response.name) {
    throw new Error('Formula creation cancelled');
  }
  
  const config: FormulaYml = {
    name: response.name,
    version: response.version,
    ...(response.description && { description: response.description }),
    ...(response.keywords && response.keywords.length > 0 && { keywords: response.keywords }),
    ...(response.private && { private: response.private })
  };
  
  return config;
}

/**
 * Handle cancellation result from prompts
 */
export function isCancelled(result: any): boolean {
  return result === undefined;
}

/**
 * Standard cancellation message
 */
export function logCancellation(): void {
  console.log('❌ Operation cancelled');
}

import prompts from 'prompts';
import { basename } from 'path';
import { FormulaYml } from '../types/index.js';
import { UserCancellationError } from './errors.js';

/**
 * Common prompt types and utilities for user interaction
 */

/**
 * Safe wrapper around prompts() that ensures consistent cancellation handling
 * Use this instead of direct prompts() calls to ensure proper error handling
 */
export async function safePrompts(
  questions: prompts.PromptObject | prompts.PromptObject[],
  options?: prompts.Options
): Promise<prompts.Answers<string>> {
  const response = await prompts(questions, {
    onCancel: () => {
      throw new UserCancellationError('Operation cancelled by user');
    },
    ...(options || {})
  });
  
  if (isCancelled(response)) {
    throw new UserCancellationError('Operation cancelled by user');
  }
  
  return response;
}

/**
 * Prompt for simple confirmation
 */
export async function promptConfirmation(message: string, initial: boolean = false): Promise<boolean> {
  const response = await safePrompts({
    type: 'confirm',
    name: 'confirmed',
    message,
    initial
  });
  
  return (response as any).confirmed || false;
}

/**
 * Prompt for overwrite confirmation with specific formula context
 */
export async function promptFormulaOverwrite(formulaName: string, existingVersion?: string): Promise<boolean> {
  const versionSuffix = existingVersion ? ` (${existingVersion})` : '';
  return await promptConfirmation(
    `Formula '${formulaName}' already exists${versionSuffix}. Overwrite all files?`,
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
  
  const response = await safePrompts([
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
      type: 'text',
      name: 'keywords',
      message: 'Keywords (space-separated):'
    },
    {
      type: 'confirm',
      name: 'private',
      message: 'Private formula?',
      initial: false
    }
  ]);
  
  // Process keywords from space-separated string to array
  const keywordsArray = response.keywords 
    ? response.keywords.trim().split(/\s+/).filter((k: string) => k.length > 0)
    : [];

  const config: FormulaYml = {
    name: response.name,
    version: response.version,
    ...(response.description && { description: response.description }),
    ...(keywordsArray.length > 0 && { keywords: keywordsArray }),
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
 * Prompt user to enter a new version number
 */
export async function promptNewVersion(formulaName: string, versionContext: string): Promise<string> {
  // Extract current version from context for validation
  const currentVersionMatch = versionContext.match(/current: ([^,)]+)/);
  const currentVersion = currentVersionMatch ? currentVersionMatch[1] : versionContext;
  
  const response = await safePrompts({
    type: 'text',
    name: 'version',
    message: `Enter a new version for '${formulaName}' (${versionContext}):`,
    initial: currentVersion,
    validate: (value: string) => {
      if (!value) return 'Version is required';
      if (!/^\d+\.\d+\.\d+/.test(value)) {
        return 'Version should follow semantic versioning (e.g., 1.0.0)';
      }
      if (value === currentVersion) {
        return 'New version must be different from current version';
      }
      return true;
    }
  });

  return response.version;
}

/**
 * Prompt user to confirm version overwrite
 */
export async function promptVersionOverwrite(formulaName: string, oldVersion: string, newVersion: string): Promise<boolean> {
  return await promptConfirmation(
    `Overwrite formula '${formulaName}' version ${oldVersion} with version ${newVersion}?`,
    false
  );
}

/**
 * Prompt user to select platform they're using
 */
export async function promptPlatformSelection(): Promise<string[]> {
  const response = await safePrompts({
    type: 'select',
    name: 'platform',
    message: 'Which platform are you using for AI-assisted development?',
    choices: [
      { title: 'Cursor IDE', value: 'cursor' },
      { title: 'Claude Code', value: 'claude' },
      { title: 'Other/None', value: 'other' }
    ],
    hint: 'Use arrow keys to navigate, Enter to select'
  });

  // If user selected "other", return empty array
  if (response.platform === 'other') {
    return [];
  }

  // Return single selection as array for consistency
  return response.platform ? [response.platform] : [];
}

/**
 * Prompt for version selection from available versions
 */
export async function promptVersionSelection(
  formulaName: string,
  versions: string[],
  action: string = ''
): Promise<string> {
  const response = await safePrompts({
    type: 'select',
    name: 'version',
    message: `Select version of '${formulaName}' ${action}:`,
    choices: versions.map(version => ({
      title: version,
      value: version
    })),
    hint: 'Use arrow keys to navigate, Enter to select'
  });

  return response.version;
}

/**
 * Prompt for confirmation when deleting specific version
 */
export async function promptVersionDelete(
  formulaName: string, 
  version: string
): Promise<boolean> {
  return await promptConfirmation(
    `Are you sure you want to delete version '${version}' of formula '${formulaName}'? This action cannot be undone.`,
    false
  );
}

/**
 * Prompt for confirmation when deleting all versions
 */
export async function promptAllVersionsDelete(
  formulaName: string, 
  versionCount: number
): Promise<boolean> {
  const versionText = versionCount === 1 ? 'version' : 'versions';
  return await promptConfirmation(
    `Are you sure you want to delete all ${versionCount} ${versionText} of formula '${formulaName}'? This action cannot be undone.`,
    false
  );
}

/**
 * Prompt for confirmation when deleting prerelease versions of a base version
 */
export async function promptPrereleaseVersionsDelete(
  formulaName: string,
  baseVersion: string,
  prereleaseVersions: string[]
): Promise<boolean> {
  const versionText = prereleaseVersions.length === 1 ? 'version' : 'versions';
  const versionsList = prereleaseVersions.join(', ');
  
  return await promptConfirmation(
    `Are you sure you want to delete ${prereleaseVersions.length} prerelease ${versionText} of '${formulaName}@${baseVersion}'?\n` +
    `Versions to delete: ${versionsList}\n` +
    `This action cannot be undone.`,
    false
  );
}

/**
 * Prompt user for formula installation conflict resolution
 */
export async function promptFormulaInstallConflict(
  formulaName: string,
  existingVersion: string,
  newVersion: string,
  requiredVersion?: string
): Promise<'keep' | 'latest' | 'exact'> {
  // Determine the version to show for "Install exact" option
  const exactVersion = requiredVersion || newVersion;
  const exactDescription = requiredVersion 
    ? `Install version ${exactVersion} as required by dependency tree`
    : `Install version ${exactVersion}, may be older than current`;

  const response = await safePrompts({
    type: 'select',
    name: 'choice',
    message: `Formula '${formulaName}' already installed. How would you like to proceed?`,
    choices: [
      {
        title: `Keep installed - Skip installation`,
        value: 'keep',
        description: 'Keep the currently installed version'
      },
      {
        title: `Install latest - Overwrite`,
        value: 'latest',
        description: 'Install the latest version, overwriting existing'
      },
      {
        title: `Install exact (v${exactVersion}) - Overwrite with specific version`,
        value: 'exact',
        description: exactDescription
      }
    ],
    hint: 'Use arrow keys to navigate, Enter to select'
  });

  return response.choice;
}

/**
 * Prompt user for version conflict resolution when saving
 */
export async function promptVersionConflictResolution(
  formulaName: string,
  existingVersion: string
): Promise<'bump-patch' | 'bump-minor' | 'overwrite'> {
  const response = await safePrompts({
    type: 'select',
    name: 'choice',
    message: `Version '${existingVersion}' of formula '${formulaName}' already exists. How would you like to proceed?`,
    choices: [
      {
        title: `Bump patch - Increment patch version (${existingVersion} → ${bumpPatchVersion(existingVersion)})`,
        value: 'bump-patch',
        description: 'Increment the patch version for bug fixes'
      },
      {
        title: `Bump minor - Increment minor version (${existingVersion} → ${bumpMinorVersion(existingVersion)})`,
        value: 'bump-minor',
        description: 'Increment the minor version for new features'
      },
      {
        title: `Overwrite existing - Replace existing version`,
        value: 'overwrite',
        description: 'Replace the existing version (requires confirmation)'
      }
    ],
    hint: 'Use arrow keys to navigate, Enter to select'
  });

  return response.choice;
}

/**
 * Prompt user to confirm overwrite with double confirmation
 */
export async function promptOverwriteConfirmation(
  formulaName: string,
  version: string
): Promise<boolean> {
  const response = await safePrompts({
    type: 'confirm',
    name: 'confirmed',
    message: `Are you sure you want to overwrite version '${version}' of formula '${formulaName}'? This action cannot be undone.`,
    initial: false
  });

  return response.confirmed || false;
}

/**
 * Bump patch version (e.g., 1.2.3 → 1.2.4)
 */
function bumpPatchVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length >= 3) {
    const patch = parseInt(parts[2], 10) + 1;
    return `${parts[0]}.${parts[1]}.${patch}`;
  }
  return version;
}

/**
 * Bump minor version (e.g., 1.2.3 → 1.3.0)
 */
function bumpMinorVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length >= 2) {
    const minor = parseInt(parts[1], 10) + 1;
    return `${parts[0]}.${minor}.0`;
  }
  return version;
}

/**
 * File selection option interface
 */
interface FileSelectionOption {
  platform: string;
  sourcePath: string;
  preview: string;
  registryPath: string;
}

/**
 * Prompt user to mark multiple files as platform-specific
 */
export async function promptPlatformSpecificSelection(
  options: FileSelectionOption[],
  message: string = 'Select files to mark as platform-specific (they will keep their platform prefixes):',
  hint?: string
): Promise<number[]> {
  const response = await safePrompts({
    type: 'multiselect',
    name: 'platformSpecificIndices',
    message,
    choices: options.map((option, index) => ({
      title: `${option.platform}: ${option.registryPath}`,
      value: index,
      description: option.preview.substring(0, 50) + (option.preview.length > 50 ? '...' : '')
    })),
    hint: hint || 'Use space to select, Enter to confirm'
  });

  return response.platformSpecificIndices || [];
}

/**
 * Get preview of file content (first few lines)
 */
export async function getContentPreview(filePath: string, maxLines: number = 3): Promise<string> {
  try {
    const { readTextFile } = await import('./fs.js');
    const content = await readTextFile(filePath);
    const lines = content.split('\n').slice(0, maxLines);
    return lines.join('\n').substring(0, 100) + (lines.length >= maxLines ? '...' : '');
  } catch {
    return '[Unable to read preview]';
  }
}


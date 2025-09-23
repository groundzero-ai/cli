import prompts from 'prompts';
import { basename } from 'path';
import { FormulaYml } from '../types/index.js';
import { UserCancellationError } from './errors.js';

/**
 * Common prompt types and utilities for user interaction
 */

/**
 * Prompt for simple confirmation
 */
export async function promptConfirmation(message: string, initial: boolean = false): Promise<boolean> {
  const response = await prompts({
    type: 'confirm',
    name: 'confirmed',
    message,
    initial
  });
  
  if (isCancelled(response)) {
    throw new UserCancellationError();
  }
  
  return response.confirmed || false;
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
  
  // Handle user cancellation
  if (isCancelled(response) || !response.name) {
    throw new UserCancellationError('Formula creation cancelled');
  }
  
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
  
  const response = await prompts({
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

  if (isCancelled(response) || !response.version) {
    throw new UserCancellationError('Version update cancelled');
  }

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
  const response = await prompts({
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

  if (isCancelled(response)) {
    throw new UserCancellationError();
  }

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
  versions: string[]
): Promise<string> {
  const response = await prompts({
    type: 'select',
    name: 'version',
    message: `Select version of '${formulaName}' to delete:`,
    choices: versions.map(version => ({
      title: version,
      value: version
    })),
    hint: 'Use arrow keys to navigate, Enter to select'
  });

  if (isCancelled(response) || !response.version) {
    throw new UserCancellationError('Version selection cancelled');
  }

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

  const response = await prompts({
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

  if (isCancelled(response) || !response.choice) {
    throw new UserCancellationError('Formula installation cancelled');
  }

  return response.choice;
}

/**
 * Prompt user for version conflict resolution when saving
 */
export async function promptVersionConflictResolution(
  formulaName: string,
  existingVersion: string
): Promise<'bump-patch' | 'bump-minor' | 'overwrite'> {
  const response = await prompts({
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

  if (isCancelled(response) || !response.choice) {
    throw new UserCancellationError('Version conflict resolution cancelled');
  }

  return response.choice;
}

/**
 * Prompt user to confirm overwrite with double confirmation
 */
export async function promptOverwriteConfirmation(
  formulaName: string,
  version: string
): Promise<boolean> {
  const response = await prompts({
    type: 'confirm',
    name: 'confirmed',
    message: `Are you sure you want to overwrite version '${version}' of formula '${formulaName}'? This action cannot be undone.`,
    initial: false
  });

  if (isCancelled(response)) {
    throw new UserCancellationError('Overwrite confirmation cancelled');
  }

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


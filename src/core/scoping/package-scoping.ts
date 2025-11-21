import { SCOPED_PACKAGE_REGEX, normalizePackageName, validatePackageName } from '../../utils/package-name.js';
import { listAllPackages, getPackagePath } from '../directory.js';
import { exists } from '../../utils/fs.js';
import { configManager } from '../config.js';
import { safePrompts } from '../../utils/prompts.js';
import { UserCancellationError } from '../../utils/errors.js';

/**
 * Determine if a package name is scoped (@scope/name).
 */
export function isScopedName(name: string): boolean {
  return SCOPED_PACKAGE_REGEX.test(name);
}

/**
 * Extract the local (non-scope) part from a package name.
 */
export function getLocalPart(name: string): string {
  const match = name.match(SCOPED_PACKAGE_REGEX);
  return match ? match[2] : name;
}

/**
 * Get all scoped package names in the local registry that share the same local name.
 */
export async function findScopedVariantsInRegistry(baseName: string): Promise<string[]> {
  const normalizedBase = normalizePackageName(baseName);
  const packages = await listAllPackages();

  return packages.filter(candidate => {
    const match = candidate.match(SCOPED_PACKAGE_REGEX);
    if (!match) {
      return false;
    }
    const localPart = normalizePackageName(match[2]);
    return localPart === normalizedBase;
  });
}

async function isPackageNameTaken(name: string): Promise<boolean> {
  const normalized = normalizePackageName(name);
  return await exists(getPackagePath(normalized));
}

/**
 * Fetch the configured default scope for a given profile (if any).
 */
export async function getDefaultScopeForProfile(profileName?: string): Promise<string | undefined> {
  if (!profileName) {
    return undefined;
  }

  const config = await configManager.getAll();
  const profileConfig = config.profiles?.[profileName];
  return profileConfig?.defaultScope;
}

/**
 * Suggest a scoped package name using the configured default scope.
 */
export async function suggestScopedNameFromConfig(
  unscopedName: string,
  profileName?: string
): Promise<string | undefined> {
  const defaultScope = await getDefaultScopeForProfile(profileName);
  if (!defaultScope) {
    return undefined;
  }

  const normalizedScope = normalizePackageName(defaultScope.replace(/^@/, ''));
  const normalizedName = normalizePackageName(unscopedName);
  return `@${normalizedScope}/${normalizedName}`;
}

/**
 * Prompt user for a new scoped name and ensure it does not already exist locally.
 */
export async function promptForNewScopedName(
  baseName: string,
  profileName?: string,
  message?: string
): Promise<string> {
  const initial = await suggestScopedNameFromConfig(baseName, profileName);

  const response = await safePrompts({
    type: 'text',
    name: 'name',
    message: message ?? `Enter a scoped name for '${baseName}' (format @scope/${baseName}):`,
    initial,
    validate: async (value: string) => {
      if (!value) return 'Name is required';
      try {
        validatePackageName(value);
      } catch (error) {
        return (error as Error).message.replace('%s', value);
      }
      if (!isScopedName(value)) {
        return 'Name must be scoped (e.g. @scope/name)';
      }
      if (await isPackageNameTaken(value)) {
        return `Package '${value}' already exists in local registry. Choose a different scoped name.`;
      }
      return true;
    }
  });

  const scopedName = (response as any).name as string | undefined;
  if (!scopedName) {
    throw new UserCancellationError('Operation cancelled by user');
  }

  return normalizePackageName(scopedName);
}

/**
 * Determine the scoped name to use when pushing an unscoped package.
 */
export async function resolveScopedNameForPush(
  unscopedName: string,
  profileName?: string
): Promise<string> {
  if (isScopedName(unscopedName)) {
    throw new Error(`Expected unscoped name, received '${unscopedName}'`);
  }

  return await promptForNewScopedName(
    unscopedName,
    profileName,
    `Remote registry requires a scope. Enter a scoped name for '${unscopedName}' (format @scope/${unscopedName}):`
  );
}

export interface SaveNameResolution {
  effectiveName: string;
  selectedExistingScopedName?: string;
  newScopedName?: string;
  nameChanged: boolean;
}

/**
 * Resolve which name should be used for a save invocation, prompting when needed.
 */
export async function resolveEffectiveNameForSave(
  inputName: string,
  profileName?: string
): Promise<SaveNameResolution> {
  const normalizedInput = normalizePackageName(inputName);

  if (isScopedName(normalizedInput)) {
    return {
      effectiveName: normalizedInput,
      nameChanged: false
    };
  }

  const scopedVariants = await findScopedVariantsInRegistry(normalizedInput);
  if (scopedVariants.length === 0) {
    return {
      effectiveName: normalizedInput,
      nameChanged: false
    };
  }

  const selection = await safePrompts({
    type: 'select',
    name: 'choice',
    message: `Found scoped packages matching '${normalizedInput}'. How should this save proceed?`,
    choices: [
      ...scopedVariants.map(variant => ({
        title: `Use existing scoped package ${variant}`,
        value: variant,
        description: `Treat this package as '${variant}'`
      })),
      {
        title: 'Create a new scoped name',
        value: '__create_new_scoped__',
        description: 'Create a brand new scoped identity (will prompt for name)'
      },
      {
        title: `Keep unscoped name '${normalizedInput}'`,
        value: '__keep_unscoped__',
        description: 'Continue saving as unscoped (push will still require scoping later)'
      }
    ],
    hint: 'Use arrow keys to select, Enter to confirm'
  });

  const choice = (selection as any).choice as string | undefined;
  if (!choice) {
    throw new UserCancellationError('Operation cancelled by user');
  }

  if (choice === '__keep_unscoped__') {
    return {
      effectiveName: normalizedInput,
      nameChanged: false
    };
  }

  if (choice === '__create_new_scoped__') {
    const newScopedName = await promptForNewScopedName(normalizedInput, profileName);
    return {
      effectiveName: newScopedName,
      newScopedName,
      nameChanged: newScopedName !== normalizedInput
    };
  }

  const normalizedChoice = normalizePackageName(choice);
  return {
    effectiveName: normalizedChoice,
    selectedExistingScopedName: normalizedChoice,
    nameChanged: normalizedChoice !== normalizedInput
  };
}


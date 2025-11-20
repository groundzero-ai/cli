import { ValidationError } from './errors.js';
import { PackageDependency } from '../types/index.js';

/**
 * Regex pattern for scoped package names (@scope/name)
 */
export const SCOPED_PACKAGE_REGEX = /^@([^\/]+)\/(.+)$/;

/**
 * Error messages for package name validation
 */
const ERROR_MESSAGES = {
  INVALID_PACKAGE_NAME: 'Invalid package name: %s. Package names must be 1-214 characters, contain only letters, numbers, hyphens, underscores, and dots. Cannot start with a number, dot, or hyphen. Cannot have consecutive dots, underscores, or hyphens. Scoped names must be in format @<scope>/<name>. Package names are case-insensitive and will be normalized to lowercase.'
} as const;

/**
 * Validate package name according to naming rules
 * @param name - The package name to validate
 * @throws ValidationError if the name is invalid
 */
export function validatePackageName(name: string): void {
  // Check length
  if (name.length === 0 || name.length > 214) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_PACKAGE_NAME.replace('%s', name));
  }

  // Check for leading/trailing spaces
  if (name.trim() !== name) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_PACKAGE_NAME.replace('%s', name));
  }

  // Check if it's a scoped name (@scope/name format)
  const scopedMatch = name.match(SCOPED_PACKAGE_REGEX);
  if (scopedMatch) {
    const [, scope, localName] = scopedMatch;

    // Validate scope part
    validatePackageNamePart(scope, name);

    // Validate local name part
    validatePackageNamePart(localName, name);

    return;
  }

  // Validate as regular name
  validatePackageNamePart(name, name);
}

/**
 * Validate a package name part (scope or local name)
 * @param part - The part to validate
 * @param fullName - The full original name for error messages
 * @throws ValidationError if the part is invalid
 */
function validatePackageNamePart(part: string, fullName: string): void {
  // Check first character
  if (/^[0-9.\-]/.test(part)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_PACKAGE_NAME.replace('%s', fullName));
  }

  // Check for consecutive special characters
  if (/(\.\.|__|--)/.test(part)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_PACKAGE_NAME.replace('%s', fullName));
  }

  // Check allowed characters only
  if (!/^[a-z0-9._-]+$/.test(part)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_PACKAGE_NAME.replace('%s', fullName));
  }
}

/**
 * Parse package input supporting both scoped names (@scope/name) and version specifications (name@version)
 * Returns normalized name and optional version
 */
export function parsePackageInput(packageInput: string): { name: string; version?: string } {
  // Package name with optional version
  const atIndex = packageInput.lastIndexOf('@');

  if (atIndex === -1 || atIndex === 0) {
    validatePackageName(packageInput);
    return {
      name: normalizePackageName(packageInput)
    };
  }

  const name = packageInput.substring(0, atIndex);
  const version = packageInput.substring(atIndex + 1);

  if (!name || !version) {
    throw new ValidationError(`Invalid package syntax: ${packageInput}. Use 'package' or 'package@version'`);
  }

  validatePackageName(name);

  return {
    name: normalizePackageName(name),
    version
  };
}

/**
 * Normalize a package name to lowercase, handling scoped names properly.
 * Scoped names like @Scope/Name become @scope/name.
 * Regular names like MyPackage become mypackage.
 */
export function normalizePackageName(name: string): string {
  return name.toLowerCase();
}


/**
 * Check if two package names are equivalent (case-insensitive).
 */
export function arePackageNamesEquivalent(name1: string, name2: string): boolean {
  return normalizePackageName(name1) === normalizePackageName(name2);
}
import { ValidationError } from './errors.js';
import { FormulaDependency } from '../types/index.js';

/**
 * Regex pattern for scoped formula names (@scope/name)
 */
export const SCOPED_FORMULA_REGEX = /^@([^\/]+)\/(.+)$/;

/**
 * Error messages for formula name validation
 */
const ERROR_MESSAGES = {
  INVALID_FORMULA_NAME: 'Invalid formula name: %s. Formula names must be 1-214 characters, contain only letters, numbers, hyphens, underscores, and dots. Cannot start with a number, dot, or hyphen. Cannot have consecutive dots, underscores, or hyphens. Scoped names must be in format @<scope>/<name>. Formula names are case-insensitive and will be normalized to lowercase.'
} as const;

/**
 * Validate formula name according to naming rules
 * @param name - The formula name to validate
 * @throws ValidationError if the name is invalid
 */
export function validateFormulaName(name: string): void {
  // Check length
  if (name.length === 0 || name.length > 214) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_FORMULA_NAME.replace('%s', name));
  }

  // Check for leading/trailing spaces
  if (name.trim() !== name) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_FORMULA_NAME.replace('%s', name));
  }

  // Check if it's a scoped name (@scope/name format)
  const scopedMatch = name.match(SCOPED_FORMULA_REGEX);
  if (scopedMatch) {
    const [, scope, localName] = scopedMatch;

    // Validate scope part
    validateFormulaNamePart(scope, name);

    // Validate local name part
    validateFormulaNamePart(localName, name);

    return;
  }

  // Validate as regular name
  validateFormulaNamePart(name, name);
}

/**
 * Validate a formula name part (scope or local name)
 * @param part - The part to validate
 * @param fullName - The full original name for error messages
 * @throws ValidationError if the part is invalid
 */
function validateFormulaNamePart(part: string, fullName: string): void {
  // Check first character
  if (/^[0-9.\-]/.test(part)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_FORMULA_NAME.replace('%s', fullName));
  }

  // Check for consecutive special characters
  if (/(\.\.|__|--)/.test(part)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_FORMULA_NAME.replace('%s', fullName));
  }

  // Check allowed characters only
  if (!/^[a-z0-9._-]+$/.test(part)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_FORMULA_NAME.replace('%s', fullName));
  }
}

/**
 * Parse formula input supporting both scoped names (@scope/name) and version specifications (name@version)
 * Returns normalized name and optional version
 */
export function parseFormulaInput(formulaInput: string): { name: string; version?: string } {
  // Check if this looks like a scoped formula name (@scope/name)
  // Handle this before path normalization to avoid treating it as a directory
  const scopedMatch = formulaInput.match(SCOPED_FORMULA_REGEX);
  if (scopedMatch) {
    validateFormulaName(formulaInput);
    return {
      name: normalizeFormulaName(formulaInput)
    };
  }

  // Formula name with optional version
  const atIndex = formulaInput.lastIndexOf('@');

  if (atIndex === -1) {
    validateFormulaName(formulaInput);
    return {
      name: normalizeFormulaName(formulaInput)
    };
  }

  const name = formulaInput.substring(0, atIndex);
  const version = formulaInput.substring(atIndex + 1);

  if (!name || !version) {
    throw new ValidationError(`Invalid formula syntax: ${formulaInput}. Use 'formula' or 'formula@version'`);
  }

  validateFormulaName(name);

  return {
    name: normalizeFormulaName(name),
    version
  };
}

/**
 * Normalize a formula name to lowercase, handling scoped names properly.
 * Scoped names like @Scope/Name become @scope/name.
 * Regular names like MyFormula become myformula.
 */
export function normalizeFormulaName(name: string): string {
  // Handle scoped names (@scope/name format)
  const scopedMatch = name.match(/^(@[^\/]+)\/(.+)$/);
  if (scopedMatch) {
    const [, scope, localName] = scopedMatch;
    return `${scope.toLowerCase()}/${localName.toLowerCase()}`;
  }

  // Handle regular names
  return name.toLowerCase();
}

/**
 * Normalize a formula dependency by normalizing its name.
 * Returns a new dependency object with the normalized name.
 */
export function normalizeFormulaDependency(dep: FormulaDependency): FormulaDependency {
  return {
    ...dep,
    name: normalizeFormulaName(dep.name)
  };
}

/**
 * Normalize an array of formula dependencies in-place.
 */
export function normalizeFormulaDependencies(deps: FormulaDependency[]): FormulaDependency[] {
  return deps.map(normalizeFormulaDependency);
}

/**
 * Check if two formula names are equivalent (case-insensitive).
 */
export function areFormulaNamesEquivalent(name1: string, name2: string): boolean {
  return normalizeFormulaName(name1) === normalizeFormulaName(name2);
}
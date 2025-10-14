import { ValidationError } from './errors.js';

/**
 * Regex pattern for scoped formula names (@scope/name)
 */
export const SCOPED_FORMULA_REGEX = /^@([^\/]+)\/(.+)$/;

/**
 * Error messages for formula name validation
 */
const ERROR_MESSAGES = {
  INVALID_FORMULA_NAME: 'Invalid formula name: %s. Formula names must be 1-214 characters, contain only lowercase letters, numbers, hyphens, underscores, and dots. Cannot start with a number, dot, or hyphen. Cannot have consecutive dots, underscores, or hyphens. Scoped names must be in format @<scope>/<name>.'
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

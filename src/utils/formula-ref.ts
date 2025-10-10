import * as semver from 'semver';
import { ValidationError } from './errors.js';

export interface ParsedFormulaRef {
  name: string;
  version?: string;
}

/**
 * Parse a formula reference supporting optional exact version via name@version.
 * - If no '@' present, returns name with undefined version (caller uses latest).
 * - If version present, it must be an exact semver (no ranges).
 */
export function parseFormulaRefExact(input: string): ParsedFormulaRef {
  const atIndex = input.lastIndexOf('@');

  if (atIndex === -1) {
    return { name: input };
  }

  const name = input.substring(0, atIndex);
  const version = input.substring(atIndex + 1);

  if (!name || !version) {
    throw new ValidationError(`Invalid formula syntax: ${input}. Use 'formula' or 'formula@version'`);
  }

  if (!semver.valid(version)) {
    throw new ValidationError(
      `Invalid version format: ${version}. Expected exact semver (e.g., 1.2.3)`
    );
  }

  return { name, version };
}



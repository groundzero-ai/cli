import { G0Error, ErrorCodes, CommandResult } from '../types/index.js';
import { logger } from './logger.js';

/**
 * Custom error classes for different types of errors in the G0 CLI
 */

export class FormulaNotFoundError extends G0Error {
  constructor(formulaName: string) {
    super(`Formula '${formulaName}' not found`, ErrorCodes.FORMULA_NOT_FOUND, { formulaName });
  }
}

export class FormulaVersionNotFoundError extends G0Error {
  constructor(message: string) {
    super(message, ErrorCodes.FORMULA_NOT_FOUND);
  }
}

export class VersionConflictError extends G0Error {
  constructor(
    formulaName: string,
    details: {
      ranges: string[];
      parents?: string[];
      availableVersions?: string[];
    }
  ) {
    const msg = `No version of '${formulaName}' satisfies ranges: ${details.ranges.join(', ')}${details.availableVersions?.length ? `. Available: ${details.availableVersions.join(', ')}` : ''}`;
    super(msg, ErrorCodes.VALIDATION_ERROR, { formulaName, ...details });
    this.name = 'VersionConflictError';
  }
}

export class FormulaAlreadyExistsError extends G0Error {
  constructor(formulaName: string) {
    super(`Formula '${formulaName}' already exists`, ErrorCodes.FORMULA_ALREADY_EXISTS, { formulaName });
  }
}

export class InvalidFormulaError extends G0Error {
  constructor(reason: string, details?: any) {
    super(`Invalid formula: ${reason}`, ErrorCodes.INVALID_FORMULA, details);
  }
}

export class RegistryError extends G0Error {
  constructor(message: string, details?: any) {
    super(`Registry error: ${message}`, ErrorCodes.REGISTRY_ERROR, details);
  }
}

export class NetworkError extends G0Error {
  constructor(message: string, details?: any) {
    super(`Network error: ${message}`, ErrorCodes.NETWORK_ERROR, details);
  }
}

export class FileSystemError extends G0Error {
  constructor(message: string, details?: any) {
    super(`File system error: ${message}`, ErrorCodes.FILE_SYSTEM_ERROR, details);
  }
}

export class PermissionError extends G0Error {
  constructor(message: string, details?: any) {
    super(`Permission error: ${message}`, ErrorCodes.PERMISSION_ERROR, details);
  }
}

export class ValidationError extends G0Error {
  constructor(message: string, details?: any) {
    super(`Validation error: ${message}`, ErrorCodes.VALIDATION_ERROR, details);
  }
}

export class ConfigError extends G0Error {
  constructor(message: string, details?: any) {
    super(`Configuration error: ${message}`, ErrorCodes.CONFIG_ERROR, details);
  }
}

export class UserCancellationError extends Error {
  constructor(message: string = 'Operation cancelled by user') {
    super(message);
    this.name = 'UserCancellationError';
  }
}

/**
 * Error handler function that provides consistent error handling across commands
 */
export function handleError(error: unknown): CommandResult {
  if (error instanceof G0Error) {
    // Don't log version-specific errors as they're already formatted nicely
    if (!(error instanceof FormulaVersionNotFoundError)) {
      logger.error(error.message, { code: error.code, details: error.details });
    }
    return {
      success: false,
      error: error.message
    };
  } else if (error instanceof Error) {
    logger.error('Unexpected error occurred', { message: error.message, stack: error.stack });
    return {
      success: false,
      error: `Unexpected error: ${error.message}`
    };
  } else {
    logger.error('Unknown error occurred', { error });
    return {
      success: false,
      error: 'An unknown error occurred'
    };
  }
}

/**
 * Wraps an async function with error handling for Commander.js actions
 */
export function withErrorHandling<T extends any[]>(
  fn: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    try {
      await fn(...args);
    } catch (error) {
      // Handle user cancellation gracefully - just exit without error message
      if (error instanceof UserCancellationError) {
        process.exit(0);
        return;
      }
      
      const result = handleError(error);
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }
  };
}

/**
 * Assertion helper that throws a G0Error if condition is false
 */
export function assert(condition: boolean, message: string, code: ErrorCodes = ErrorCodes.VALIDATION_ERROR, details?: any): asserts condition {
  if (!condition) {
    throw new G0Error(message, code, details);
  }
}

/**
 * Type guard to check if an error is a G0Error
 */
export function isG0Error(error: unknown): error is G0Error {
  return error instanceof G0Error;
}

import { OpenPackageError, ErrorCodes, CommandResult } from '../types/index.js';
import { logger } from './logger.js';

/**
 * Custom error classes for different types of errors in the OpenPackage CLI
 */

export class PackageNotFoundError extends OpenPackageError {
  constructor(packageName: string) {
    super(`Package '${packageName}' not found`, ErrorCodes.PACKAGE_NOT_FOUND, { packageName });
  }
}

export class PackageVersionNotFoundError extends OpenPackageError {
  constructor(message: string) {
    super(message, ErrorCodes.PACKAGE_NOT_FOUND);
  }
}

export class VersionConflictError extends OpenPackageError {
  constructor(
    packageName: string,
    details: {
      ranges: string[];
      parents?: string[];
      availableVersions?: string[];
    }
  ) {
    const msg = `No version of '${packageName}' satisfies ranges: ${details.ranges.join(', ')}${details.availableVersions?.length ? `. Available: ${details.availableVersions.join(', ')}` : ''}`;
    super(msg, ErrorCodes.VALIDATION_ERROR, { packageName, ...details });
    this.name = 'VersionConflictError';
  }
}

export class PackageAlreadyExistsError extends OpenPackageError {
  constructor(packageName: string) {
    super(`Package '${packageName}' already exists`, ErrorCodes.PACKAGE_ALREADY_EXISTS, { packageName });
  }
}

export class InvalidPackageError extends OpenPackageError {
  constructor(reason: string, details?: any) {
    super(`Invalid package: ${reason}`, ErrorCodes.INVALID_PACKAGE, details);
  }
}

export class RegistryError extends OpenPackageError {
  constructor(message: string, details?: any) {
    super(`Registry error: ${message}`, ErrorCodes.REGISTRY_ERROR, details);
  }
}

export class NetworkError extends OpenPackageError {
  constructor(message: string, details?: any) {
    super(`Network error: ${message}`, ErrorCodes.NETWORK_ERROR, details);
  }
}

export class FileSystemError extends OpenPackageError {
  constructor(message: string, details?: any) {
    super(`File system error: ${message}`, ErrorCodes.FILE_SYSTEM_ERROR, details);
  }
}

export class PermissionError extends OpenPackageError {
  constructor(message: string, details?: any) {
    super(`Permission error: ${message}`, ErrorCodes.PERMISSION_ERROR, details);
  }
}

export class ValidationError extends OpenPackageError {
  constructor(message: string, details?: any) {
    super(`Validation error: ${message}`, ErrorCodes.VALIDATION_ERROR, details);
  }
}

export class ConfigError extends OpenPackageError {
  constructor(message: string, details?: any) {
    super(message, ErrorCodes.CONFIG_ERROR, details);
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
  if (error instanceof OpenPackageError) {
    // For CLI UX, avoid noisy error logs by default; surface details only in verbose mode
    if (!(error instanceof PackageVersionNotFoundError)) {
      logger.debug(error.message, { code: error.code, details: error.details });
    }
    return {
      success: false,
      error: error.message
    };
  } else if (error instanceof Error) {
    logger.debug('Unexpected error occurred', { message: error.message, stack: error.stack });
    return {
      success: false,
      error: error.message
    };
  } else {
    logger.debug('Unknown error occurred', { error });
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
      console.error(result.error);
      process.exit(1);
    }
  };
}

/**
 * Assertion helper that throws a OpenPackageError if condition is false
 */
export function assert(condition: boolean, message: string, code: ErrorCodes = ErrorCodes.VALIDATION_ERROR, details?: any): asserts condition {
  if (!condition) {
    throw new OpenPackageError(message, code, details);
  }
}

/**
 * Type guard to check if an error is a OpenPackageError
 */
export function isOpenPackageError(error: unknown): error is OpenPackageError {
  return error instanceof OpenPackageError;
}

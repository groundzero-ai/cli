import { logger } from './logger.js';
import { ValidationError } from './errors.js';

/**
 * Wrap file operations with consistent error handling
 */
export async function withFileOperationErrorHandling<T>(
  operation: () => Promise<T>,
  filePath: string,
  operationName: string = 'file operation'
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logger.error(`Failed to ${operationName}: ${filePath}`, { error });
    throw new ValidationError(`Failed to ${operationName} ${filePath}: ${error}`);
  }
}

/**
 * Wrap async operations with consistent error handling and context
 */
export async function withOperationErrorHandling<T>(
  operation: () => Promise<T>,
  operationName: string,
  context?: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = context ? `${operationName} failed: ${context}` : `${operationName} failed`;
    logger.error(message, { error });
    throw new Error(`${message}: ${error}`);
  }
}

/**
 * Handle user cancellation errors consistently
 */
export function handleUserCancellation(error: unknown): { shouldProceed: boolean; skippedFormulas: string[]; versionOverrides: Map<string, string>; forceOverwriteFormulas: Set<string> } {
  logger.warn(`User cancelled operation: ${error}`);
  return {
    shouldProceed: false,
    skippedFormulas: [],
    versionOverrides: new Map(),
    forceOverwriteFormulas: new Set()
  };
}

/**
 * Create consistent error messages for formula operations
 */
export function createFormulaError(formulaName: string, operation: string, error: unknown): string {
  return `${operation} failed for formula '${formulaName}': ${error}`;
}

/**
 * Wrap formula installation with error handling
 */
export async function withFormulaInstallationErrorHandling<T>(
  operation: () => Promise<T>,
  formulaName: string
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const errorMessage = createFormulaError(formulaName, 'Installation', error);
    logger.error(errorMessage, { error });
    throw new Error(errorMessage);
  }
}

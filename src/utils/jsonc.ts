/**
 * JSONC (JSON with Comments) file utilities
 * Handles reading and parsing JSONC files with comment support
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'jsonc-parser';
import { logger } from './logger.js';

/**
 * Get the project root directory
 * Works in both development (src/) and production (dist/) environments
 */
function getProjectRoot(): string {
  // Get the directory of the current file
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  
  // If we're in dist/utils, go up two levels to project root
  // If we're in src/utils, go up two levels to project root
  // Both src/utils and dist/utils are 2 levels deep from root
  return join(__dirname, '..', '..');
}

/**
 * Read and parse a JSONC file from the project root
 * @param relativePath - Path relative to project root (e.g., 'platforms.jsonc')
 * @returns Parsed JSON object
 */
export function readJsoncFileSync<T = unknown>(relativePath: string): T {
  const projectRoot = getProjectRoot();
  const fullPath = join(projectRoot, relativePath);
  
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const parsed = parse(content);
    
    if (parsed === undefined) {
      throw new Error(`Failed to parse JSONC file: ${relativePath}`);
    }
    
    return parsed as T;
  } catch (error) {
    logger.error(`Failed to read JSONC file: ${relativePath}`, { error, fullPath });
    throw new Error(`Failed to read JSONC file ${relativePath}: ${error}`);
  }
}


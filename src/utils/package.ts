import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Utility functions for working with package.json
 */

// Get current file directory in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Read package.json and return the parsed content
 */
export function getPackageJson(): any {
  return JSON.parse(
    readFileSync(join(__dirname, '../../package.json'), 'utf8')
  );
}

/**
 * Get the version from package.json
 */
export function getVersion(): string {
  return getPackageJson().version;
}

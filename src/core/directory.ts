import * as os from 'os';
import * as path from 'path';
import { G0Directories } from '../types/index.js';
import { ensureDir } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

/**
 * Cross-platform directory resolution following platform conventions
 */

/**
 * Get G0 directories following platform-specific conventions
 * - Windows: Uses APPDATA/LOCALAPPDATA
 * - macOS: Uses Library directories
 * - Linux/Unix: Uses XDG Base Directory Specification
 */
export function getG0Directories(): G0Directories {
  const platform = process.platform;
  const homeDir = os.homedir();
  
  switch (platform) {
    case 'win32':
      // Windows doesn't follow XDG, use Windows conventions
      return {
        config: path.join(process.env.APPDATA || homeDir, 'g0'),
        data: path.join(process.env.LOCALAPPDATA || homeDir, 'g0'),
        cache: path.join(process.env.LOCALAPPDATA || homeDir, 'g0', 'cache'),
        runtime: path.join(process.env.TEMP || os.tmpdir(), 'g0')
      };
    case 'darwin':
      // macOS doesn't follow XDG, use macOS conventions
      return {
        config: path.join(homeDir, 'Library', 'Preferences', 'g0'),
        data: path.join(homeDir, 'Library', 'Application Support', 'g0'),
        cache: path.join(homeDir, 'Library', 'Caches', 'g0'),
        runtime: path.join(os.tmpdir(), 'g0')
      };
    default:
      // Linux and Unix-like systems - FULL XDG compliance
      return {
        config: path.join(
          process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 
          'g0'
        ),
        data: path.join(
          process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 
          'g0'
        ),
        cache: path.join(
          process.env.XDG_CACHE_HOME || path.join(homeDir, '.cache'), 
          'g0'
        ),
        runtime: path.join(
          process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `g0-${process.getuid?.() || process.pid}`),
          'g0'
        )
      };
  }
}

/**
 * Ensure all G0 directories exist
 */
export async function ensureG0Directories(): Promise<G0Directories> {
  const g0Dirs = getG0Directories();
  
  try {
    await Promise.all([
      ensureDir(g0Dirs.config),
      ensureDir(g0Dirs.data),
      ensureDir(g0Dirs.cache),
      ensureDir(g0Dirs.runtime)
    ]);
    
    logger.debug('G0 directories ensured', { directories: g0Dirs });
    return g0Dirs;
  } catch (error) {
    logger.error('Failed to create G0 directories', { error, directories: g0Dirs });
    throw error;
  }
}

/**
 * Get the registry directories
 */
export function getRegistryDirectories(): { formulas: string } {
  const g0Dirs = getG0Directories();
  const registryDir = path.join(g0Dirs.data, 'registry');
  
  return {
    formulas: path.join(registryDir, 'formulas')
  };
}

/**
 * Ensure registry directories exist
 */
export async function ensureRegistryDirectories(): Promise<{ formulas: string }> {
  const dirs = getRegistryDirectories();
  
  try {
    await ensureDir(dirs.formulas);
    
    logger.debug('Registry directories ensured', { directories: dirs });
    return dirs;
  } catch (error) {
    logger.error('Failed to create registry directories', { error, directories: dirs });
    throw error;
  }
}

/**
 * Get the cache directory for a specific type of cache
 */
export function getCacheDirectory(cacheType: string): string {
  const g0Dirs = getG0Directories();
  return path.join(g0Dirs.cache, cacheType);
}

/**
 * Get the temporary directory for a specific operation
 */
export function getTempDirectory(operation: string): string {
  const g0Dirs = getG0Directories();
  return path.join(g0Dirs.runtime, operation);
}

/**
 * Get the path to store a formula
 */
export function getFormulaPath(formulaName: string): string {
  const dirs = getRegistryDirectories();
  return path.join(dirs.formulas, formulaName);
}


import { basename, dirname, normalize, relative, sep, isAbsolute } from 'path';

/**
 * Centralized path normalization utilities for cross-platform compatibility
 * Provides consistent path handling across different filesystem types (Windows, macOS, Linux)
 */

/**
 * Determine if we're on a case-insensitive filesystem (primarily Windows)
 */
export function isCaseInsensitiveFilesystem(): boolean {
  return process.platform === 'win32';
}

/**
 * Normalize a path to use consistent forward slashes for internal processing
 * This ensures cross-platform compatibility while maintaining the original path semantics
 */
export function normalizePathForProcessing(path: string): string {
  return normalize(path).replace(/\\/g, '/');
}

/**
 * Split a path into components using the appropriate separator for the current platform
 * This replaces hard-coded split('/') operations that fail on Windows
 */
export function splitPath(path: string): string[] {
  // Normalize first to handle mixed separators, then split on the platform separator
  const normalized = normalize(path);
  return normalized.split(sep);
}

/**
 * Get the last component of a path (equivalent to basename but cross-platform safe)
 */
export function getPathLeaf(path: string): string {
  // First normalize backslashes to forward slashes, then normalize, then get basename
  const normalizedSlashes = path.replace(/\\/g, '/');
  return basename(normalizedSlashes);
}

/**
 * Get the parent directory of a path (equivalent to dirname but cross-platform safe)
 */
export function getPathParent(path: string): string {
  // First normalize backslashes to forward slashes, then get dirname
  const normalizedSlashes = path.replace(/\\/g, '/');
  return dirname(normalizedSlashes);
}

/**
 * Get relative path components by splitting on platform-appropriate separators
 * Returns the individual directory/file components of a relative path
 */
export function getRelativePathParts(relativePath: string): string[] {
  // Remove leading/trailing separators and split
  const cleanPath = relativePath.replace(/^\/+|\/+$/g, '');
  return cleanPath ? cleanPath.split(sep) : [];
}

/**
 * Extract the first directory component from a relative path
 * Useful for parsing registry paths like "rules/subdir/file.md" -> "rules"
 */
export function getFirstPathComponent(relativePath: string): string {
  const parts = getRelativePathParts(relativePath);
  return parts.length > 0 ? parts[0] : '';
}

/**
 * Extract everything after the first directory component
 * Useful for parsing registry paths like "rules/subdir/file.md" -> "subdir/file.md"
 */
export function getPathAfterFirstComponent(relativePath: string): string {
  const parts = getRelativePathParts(relativePath);
  return parts.length > 1 ? parts.slice(1).join(sep) : '';
}

/**
 * Check if a path contains a specific component at any level
 * Performs case-insensitive matching on case-insensitive filesystems
 */
export function pathContainsComponent(path: string, component: string): boolean {
  const parts = splitPath(path);
  const isCaseInsensitive = process.platform === 'win32';

  const searchComponent = isCaseInsensitive ? component.toLowerCase() : component;

  return parts.some(part => {
    const comparePart = isCaseInsensitive ? part.toLowerCase() : part;
    return comparePart === searchComponent;
  });
}

/**
 * Create a platform-safe relative path from components
 * This replaces manual path.join() operations in some cases
 */
export function joinRelativePath(...components: string[]): string {
  // Filter out empty components and join with platform separator
  return components.filter(comp => comp && comp !== '.').join(sep);
}

/**
 * Extract relative path from a full path given a base directory
 * This replaces manual substring operations like fullPath.substring(baseDir.length + 1)
 */
export function getRelativePathFromBase(fullPath: string, baseDir: string): string {
  // Normalize both paths to ensure consistent separators
  const normalizedFull = normalizePathForProcessing(fullPath);
  const normalizedBase = normalizePathForProcessing(baseDir);

  // Ensure base directory ends with separator for proper relative calculation
  const baseWithSep = normalizedBase.endsWith('/') ? normalizedBase : normalizedBase + '/';

  // Check if the full path starts with the base directory
  if (normalizedFull.startsWith(baseWithSep)) {
    return normalizedFull.substring(baseWithSep.length);
  }

  // Fallback: try to find relative path using Node.js path.relative
  const relativePath = relative(normalizedBase, normalizedFull);
  // Convert backslashes to forward slashes for consistency
  return relativePath.replace(/\\/g, '/');
}

/**
 * Parse a path that starts with a specific prefix and extract the remaining part
 * Useful for parsing paths like "rules/subdir/file.md" -> {prefix: "rules", remaining: "subdir/file.md"}
 */
export function parsePathWithPrefix(path: string, prefix: string): { prefix: string; remaining: string } | null {
  // Normalize the path first
  const normalizedPath = normalizePathForProcessing(path);
  const normalizedPrefix = normalizePathForProcessing(prefix);

  // Check if path starts with prefix followed by separator
  const prefixPattern = `${normalizedPrefix}/`;
  if (normalizedPath.startsWith(prefixPattern)) {
    return {
      prefix: normalizedPrefix,
      remaining: normalizedPath.substring(prefixPattern.length)
    };
  }

  return null;
}

/**
 * Find the index where a subpath appears within a full path, handling platform differences
 * Returns the index in the normalized path string
 */
export function findSubpathIndex(fullPath: string, subpath: string): number {
  const normalizedFull = normalizePathForProcessing(fullPath);
  const normalizedSub = normalizePathForProcessing(subpath);

  // Try absolute pattern (with leading slash)
  let absPattern = `/${normalizedSub}/`;
  let index = normalizedFull.indexOf(absPattern);
  if (index !== -1) {
    return index;
  }

  // Try relative pattern (without leading slash)
  let relPattern = `${normalizedSub}/`;
  index = normalizedFull.indexOf(relPattern);
  if (index !== -1) {
    return index;
  }

  return -1;
}

/**
 * Auto-normalize potential directory paths by prepending './' to relative paths with separators
 * This helps distinguish between formula names and directory paths in user input
 *
 * Examples:
 * - '.cursor/rules' -> './.cursor/rules'
 * - 'src/components' -> './src/components'
 * - 'package-name' -> 'package-name' (unchanged)
 * - './already/normalized' -> './already/normalized' (unchanged)
 * - '/absolute/path' -> '/absolute/path' (unchanged)
 */
export function autoNormalizeDirectoryPath(input: string): string {
  // If it contains path separators but doesn't start with ./ or ../, treat as relative directory
  if ((input.includes('/') || input.includes('\\')) &&
      !input.startsWith('./') &&
      !input.startsWith('../') &&
      !isAbsolute(input)) {
    return `./${input}`;
  }
  return input;
}

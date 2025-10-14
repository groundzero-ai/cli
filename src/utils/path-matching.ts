import { normalize } from 'path';

/**
 * Cross-platform path matching utilities
 * Provides consistent path matching logic across different filesystem types
 */

/**
 * Determine if we're on a case-insensitive filesystem (primarily Windows)
 */
export function isCaseInsensitiveFilesystem(): boolean {
  return process.platform === 'win32';
}

/**
 * Normalize a path for cross-platform comparison
 * Ensures consistent forward slashes and optional case-insensitive comparison
 */
export function normalizePathForComparison(path: string, caseInsensitive: boolean = isCaseInsensitiveFilesystem()): string {
  const normalized = normalize(path).replace(/\\/g, '/'); // Ensure forward slashes for consistent processing
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

/**
 * Result of matching a path against a platform directory pattern
 */
export interface PathMatchResult {
  relativePath: string;
  isAbsoluteMatch: boolean;
}

/**
 * Match a path against platform directory patterns and extract relative path
 * Handles both absolute and relative path patterns across different filesystem types
 */
export function matchPlatformPattern(
  inputPath: string,
  platformDir: string,
  caseInsensitive: boolean = isCaseInsensitiveFilesystem()
): PathMatchResult | null {
  // Normalize paths for comparison
  const normalizedInputPath = normalizePathForComparison(inputPath, caseInsensitive);
  const normalizedPlatformDir = caseInsensitive ? platformDir.toLowerCase() : platformDir;
  const comparePath = normalizedInputPath;

  // Check for platform directory patterns
  const absPlatformPattern = `/${normalizedPlatformDir}/`;
  const relPlatformPattern = `${normalizedPlatformDir}/`;

  let platformIndex = comparePath.indexOf(absPlatformPattern);
  let isAbsPattern = true;

  if (platformIndex === -1) {
    platformIndex = comparePath.indexOf(relPlatformPattern);
    isAbsPattern = false;
  }

  if (platformIndex !== -1) {
    // Extract the relative path after the platform directory
    const patternLength = isAbsPattern ? absPlatformPattern.length - 1 : relPlatformPattern.length - 1;
    let relativePath = normalizedInputPath.substring(platformIndex + patternLength);

    // Remove leading separator if present
    if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
      relativePath = relativePath.substring(1);
    }

    return { relativePath, isAbsoluteMatch: isAbsPattern };
  }

  // Check for exact platform directory matches
  const exactAbsMatch = `/${normalizedPlatformDir}`;
  const exactRelMatch = normalizedPlatformDir;

  const exactMatches = [
    comparePath === exactAbsMatch,
    comparePath === exactRelMatch,
    comparePath.endsWith(absPlatformPattern.slice(0, -1)), // ends with /platformDir
    comparePath.endsWith(relPlatformPattern.slice(0, -1))   // ends with platformDir
  ];

  if (exactMatches.some(match => match)) {
    return { relativePath: '', isAbsoluteMatch: comparePath.startsWith('/') };
  }

  return null;
}

/**
 * Check if a path exactly matches a platform directory (for root directory detection)
 */
export function isExactPlatformMatch(
  inputPath: string,
  platformDir: string,
  caseInsensitive: boolean = isCaseInsensitiveFilesystem()
): boolean {
  const comparePath = normalizePathForComparison(inputPath, caseInsensitive);
  const normalizedPlatformDir = caseInsensitive ? platformDir.toLowerCase() : platformDir;

  const exactAbsMatch = `/${normalizedPlatformDir}`;
  const exactRelMatch = normalizedPlatformDir;

  return comparePath === exactAbsMatch ||
         comparePath === exactRelMatch ||
         comparePath.endsWith(`/${normalizedPlatformDir}`);
}

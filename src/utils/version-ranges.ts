import * as semver from 'semver';

/**
 * Version range types supported by the system
 */
export type VersionRangeType = 'exact' | 'caret' | 'tilde' | 'wildcard' | 'comparison';

/**
 * Parsed version range information
 */
export interface VersionRange {
  type: VersionRangeType;
  baseVersion: string;
  range: string;
  original: string;
}

/**
 * Parse a version string into a VersionRange object
 */
export function parseVersionRange(version: string): VersionRange {
  if (!version || version.trim() === '') {
    throw new Error('Version cannot be empty');
  }

  const trimmed = version.trim();
  
  // Handle wildcard/latest
  if (trimmed === '*' || trimmed === 'latest') {
    return {
      type: 'wildcard',
      baseVersion: '0.0.0',
      range: '*',
      original: trimmed
    };
  }

  // Handle caret ranges (^1.2.3)
  if (trimmed.startsWith('^')) {
    const baseVersion = trimmed.substring(1);
    if (!semver.valid(baseVersion)) {
      throw new Error(`Invalid base version for caret range: ${baseVersion}`);
    }
    return {
      type: 'caret',
      baseVersion,
      range: trimmed,
      original: trimmed
    };
  }

  // Handle tilde ranges (~1.2.3)
  if (trimmed.startsWith('~')) {
    const baseVersion = trimmed.substring(1);
    if (!semver.valid(baseVersion)) {
      throw new Error(`Invalid base version for tilde range: ${baseVersion}`);
    }
    return {
      type: 'tilde',
      baseVersion,
      range: trimmed,
      original: trimmed
    };
  }

  // Handle comparison ranges (>=1.2.3, <2.0.0, etc.)
  if (trimmed.match(/^[><=!]+/)) {
    if (!semver.validRange(trimmed)) {
      throw new Error(`Invalid comparison range: ${trimmed}`);
    }
    // Extract base version from comparison range for display purposes
    const baseVersion = semver.minVersion(trimmed)?.version || '0.0.0';
    return {
      type: 'comparison',
      baseVersion,
      range: trimmed,
      original: trimmed
    };
  }

  // Handle exact versions (1.2.3)
  if (semver.valid(trimmed)) {
    return {
      type: 'exact',
      baseVersion: trimmed,
      range: trimmed,
      original: trimmed
    };
  }

  throw new Error(`Invalid version format: ${trimmed}`);
}

/**
 * Check if a version satisfies a version range
 */
export function satisfiesVersion(version: string, range: string): boolean {
  try {
    // Always include prerelease versions in satisfaction checks
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch (error) {
    return false;
  }
}

/**
 * Find the best version that satisfies a range from available versions
 */
export function findBestVersion(availableVersions: string[], range: string): string | null {
  try {
    // Sort versions in descending order (latest first)
    const sortedVersions = availableVersions
      .filter(v => semver.valid(v))
      .sort((a, b) => semver.compare(b, a));
    
    // Find the highest version that satisfies the range (including prereleases)
    return semver.maxSatisfying(sortedVersions, range, { includePrerelease: true });
  } catch (error) {
    return null;
  }
}

/**
 * Get the latest version from available versions
 */
export function getLatestVersion(availableVersions: string[]): string | null {
  const validVersions = availableVersions.filter(v => semver.valid(v));
  if (validVersions.length === 0) return null;
  
  return validVersions.sort((a, b) => semver.compare(b, a))[0];
}

/**
 * Create a caret range from a version (^1.2.3)
 */
export function createCaretRange(version: string): string {
  if (!semver.valid(version)) {
    throw new Error(`Invalid version for caret range: ${version}`);
  }
  return `^${version}`;
}

/**
 * Create a tilde range from a version (~1.2.3)
 */
export function createTildeRange(version: string): string {
  if (!semver.valid(version)) {
    throw new Error(`Invalid version for tilde range: ${version}`);
  }
  return `~${version}`;
}

/**
 * Check if a version range is exact (no range operators)
 */
export function isExactVersion(version: string): boolean {
  try {
    const parsed = parseVersionRange(version);
    return parsed.type === 'exact';
  } catch {
    return false;
  }
}

/**
 * Check if a version range is a wildcard (latest)
 */
export function isWildcardVersion(version: string): boolean {
  try {
    const parsed = parseVersionRange(version);
    return parsed.type === 'wildcard';
  } catch {
    return false;
  }
}

/**
 * Get a human-readable description of a version range
 */
export function describeVersionRange(version: string): string {
  try {
    const parsed = parseVersionRange(version);
    
    switch (parsed.type) {
      case 'exact':
        return `exact version ${parsed.baseVersion}`;
      case 'caret':
        return `compatible with ${parsed.baseVersion} (^${parsed.baseVersion})`;
      case 'tilde':
        return `approximately ${parsed.baseVersion} (~${parsed.baseVersion})`;
      case 'wildcard':
        return 'latest version (*)';
      case 'comparison':
        return `range ${parsed.range}`;
      default:
        return `version ${parsed.original}`;
    }
  } catch {
    return `invalid version ${version}`;
  }
}

/**
 * Resolve a version range to a specific version from available versions
 */
export function resolveVersionRange(version: string, availableVersions: string[]): string | null {
  try {
    const parsed = parseVersionRange(version);
    
    switch (parsed.type) {
      case 'exact':
        return availableVersions.includes(parsed.baseVersion) ? parsed.baseVersion : null;
      case 'wildcard':
        return getLatestVersion(availableVersions);
      default:
        // Resolve to best satisfying version including prereleases
        return findBestVersion(availableVersions, parsed.range);
    }
  } catch {
    return null;
  }
}

import * as semver from 'semver';
import { parseWipVersion } from './version-generator.js';

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

/**
 * Determine if a version string is a prerelease (includes WIP versions)
 */
export function isPrereleaseVersion(version: string): boolean {
  const parsed = semver.parse(version);
  return Boolean(parsed && parsed.prerelease.length > 0);
}

/**
 * Determine if a version string follows the WIP naming convention
 */
export function isWipVersion(version: string): boolean {
  return parseWipVersion(version) !== null;
}

/**
 * Returns the stable base (major.minor.patch) portion of a version string.
 */
export function getStableBaseVersion(version: string): string | null {
  const parsed = semver.parse(version);
  if (!parsed) {
    return null;
  }

  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

export interface VersionClassification {
  stable: string[];
  prerelease: string[];
  wip: string[];
}

export function classifyVersions(versions: string[]): VersionClassification {
  const deduped = dedupeValidVersions(versions);
  const stable: string[] = [];
  const prerelease: string[] = [];
  const wip: string[] = [];

  for (const version of deduped) {
    if (isPrereleaseVersion(version)) {
      prerelease.push(version);
      if (isWipVersion(version)) {
        wip.push(version);
      }
    } else {
      stable.push(version);
    }
  }

  return {
    stable: sortVersionsDesc(stable),
    prerelease: sortVersionsDesc(prerelease),
    wip: sortVersionsDesc(wip)
  };
}

export interface VersionSelectionOptions {
  explicitPrereleaseIntent?: boolean;
  /**
   * When true, prefer stable versions over prerelease/WIP where possible (stable-preferred policy).
   * When false or undefined (default), select the highest semver version regardless of stable vs prerelease (latest-wins policy).
   */
  preferStable?: boolean;
}

export interface VersionSelectionResult {
  version: string | null;
  isPrerelease: boolean;
  satisfyingStable: string[];
  satisfyingPrerelease: string[];
  availableStable: string[];
  availablePrerelease: string[];
  reason: 'exact' | 'wildcard' | 'range' | 'none';
}

/**
 * Determine whether a range explicitly references prerelease intent.
 */
export function hasExplicitPrereleaseIntent(range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*' || trimmed.toLowerCase() === 'latest') {
    return false;
  }

  try {
    const parsedRange = new semver.Range(trimmed, { includePrerelease: true });
    for (const comparatorSet of parsedRange.set) {
      for (const comparator of comparatorSet) {
        if (comparator.semver.prerelease.length > 0) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Select the most appropriate version according to WIP vs stable policy.
 */
export function selectVersionWithWipPolicy(
  availableVersions: string[],
  range: string,
  options?: VersionSelectionOptions
): VersionSelectionResult {
  const parsedRange = parseVersionRange(range);
  const deduped = dedupeValidVersions(availableVersions);
  const availableStable = sortVersionsDesc(deduped.filter(version => !isPrereleaseVersion(version)));
  const availablePrerelease = sortVersionsDesc(deduped.filter(version => isPrereleaseVersion(version)));
  const satisfyingStable: string[] = [];
  const satisfyingPrerelease: string[] = [];

  const result: VersionSelectionResult = {
    version: null,
    isPrerelease: false,
    satisfyingStable,
    satisfyingPrerelease,
    availableStable,
    availablePrerelease,
    reason: 'none'
  };

  if (parsedRange.type === 'exact') {
    result.reason = 'exact';
    const exactMatch = deduped.find(version => semver.eq(version, parsedRange.baseVersion));
    if (exactMatch) {
      if (isPrereleaseVersion(exactMatch)) {
        satisfyingPrerelease.push(exactMatch);
        result.isPrerelease = true;
      } else {
        satisfyingStable.push(exactMatch);
      }
      result.version = exactMatch;
    }
    return result;
  }

  const normalizedRange = parsedRange.type === 'wildcard' ? '*' : parsedRange.range;
  satisfyingStable.push(
    ...filterSatisfying(availableStable, normalizedRange, false)
  );
  satisfyingPrerelease.push(
    ...filterSatisfying(availablePrerelease, normalizedRange, true)
  );

  // Stable-preferred policy (used with --stable flag)
  if (options?.preferStable) {
    if (parsedRange.type === 'wildcard') {
      result.reason = 'wildcard';
      if (satisfyingStable.length > 0) {
        result.version = satisfyingStable[0];
        return result;
      }
      if (satisfyingPrerelease.length > 0) {
        result.version = satisfyingPrerelease[0];
        result.isPrerelease = true;
      }
      return result;
    }

    result.reason = 'range';
    if (satisfyingStable.length > 0) {
      result.version = satisfyingStable[0];
      return result;
    }

    if (satisfyingPrerelease.length === 0) {
      return result;
    }

    const explicitIntent =
      options?.explicitPrereleaseIntent ??
      hasExplicitPrereleaseIntent(parsedRange.original);
    const stableExistsAnywhere = availableStable.length > 0;

    if (explicitIntent || !stableExistsAnywhere) {
      result.version = satisfyingPrerelease[0];
      result.isPrerelease = true;
    }

    return result;
  }

  // Default policy: Latest wins (stable and WIP treated uniformly)
  const allSatisfying = sortVersionsDesc([
    ...satisfyingStable,
    ...satisfyingPrerelease
  ]);

  if (parsedRange.type === 'wildcard') {
    result.reason = 'wildcard';
  } else {
    result.reason = 'range';
  }

  if (allSatisfying.length === 0) {
    return result;
  }

  const selected = allSatisfying[0];
  result.version = selected;
  result.isPrerelease = isPrereleaseVersion(selected);
  return result;
}

function dedupeValidVersions(versions: string[]): string[] {
  const seen = new Set<string>();
  for (const version of versions) {
    if (!version || !semver.valid(version) || seen.has(version)) {
      continue;
    }
    seen.add(version);
  }
  return Array.from(seen);
}

function sortVersionsDesc(versions: string[]): string[] {
  return versions.slice().sort(semver.rcompare);
}

function filterSatisfying(
  versions: string[],
  range: string,
  includePrerelease: boolean
): string[] {
  try {
    return sortVersionsDesc(
      versions.filter(version => semver.satisfies(version, range, { includePrerelease }))
    );
  } catch {
    return [];
  }
}

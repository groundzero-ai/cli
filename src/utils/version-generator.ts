import { WIP_SUFFIX } from '../core/save/constants.js';

/**
 * Version generation utilities for local development versions
 *
 * Uses a simple `-wip` prerelease suffix for local versions so saves can
 * repeatedly overwrite the same prerelease without prompting.
 */

/**
 * Generate a local development version using a simple `-wip` suffix.
 * Format: {baseVersion}-wip
 * Uses semver prerelease identifiers for proper version ordering
 */
export function generateLocalVersion(baseVersion: string): string {
  // Ensure base version is clean semver (remove any existing prerelease or build metadata)
  const cleanVersion = baseVersion.split('-')[0].split('+')[0];

  return `${cleanVersion}${WIP_SUFFIX}`;
}

/**
 * Check if a version is a local development version
 */
export function isLocalVersion(version: string): boolean {
  return version.endsWith(WIP_SUFFIX);
}

/**
 * Extract the base version from a local development version
 * Example: "1.2.3-wip" -> "1.2.3"
 */
export function extractBaseVersion(localVersion: string): string {
  if (localVersion.endsWith(WIP_SUFFIX)) {
    return localVersion.slice(0, -WIP_SUFFIX.length);
  }

  return localVersion;
}


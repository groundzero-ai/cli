/**
 * Version generation utilities for local development versions
 * 
 * Uses semver prerelease identifiers (-dev.timestamp) for proper version ordering
 * and built-in semver comparison support.
 */

/**
 * Generate a local development version with base62 timestamp
 * Format: {baseVersion}-dev.{base62Timestamp}
 * Uses semver prerelease identifiers for proper version ordering
 */
export function generateLocalVersion(baseVersion: string): string {
  const timestamp = Date.now(); // Millisecond epoch timestamp
  const base62Hash = encodeBase62(timestamp);
  
  // Ensure base version is clean semver (remove any existing prerelease or build metadata)
  const cleanVersion = baseVersion.split('-')[0].split('+')[0]; 
  
  return `${cleanVersion}-dev.${base62Hash}`;
}

/**
 * Check if a version is a local development version
 */
export function isLocalVersion(version: string): boolean {
  return /-dev\./.test(version);
}

/**
 * Extract the base version from a local development version
 * Example: "1.2.3-dev.7r3kX" -> "1.2.3"
 */
export function extractBaseVersion(localVersion: string): string {
  return localVersion.split('-dev.')[0];
}

/**
 * Encode a number to base62 string
 * Uses characters: 0-9, A-Z, a-z (62 total)
 */
export function encodeBase62(num: number): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = '';
  
  while (num > 0) {
    result = chars[num % 62] + result;
    num = Math.floor(num / 62);
  }
  
  return result || '0';
}

/**
 * Decode a base62 string to number (for testing/debugging)
 */
export function decodeBase62(str: string): number {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let result = 0;
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const index = chars.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base62 character: ${char}`);
    }
    result = result * 62 + index;
  }
  
  return result;
}

import { createHash } from 'crypto';
import { WIP_SUFFIX } from '../core/save/constants.js';

/**
 * Version generation utilities for local development versions
 *
 * Uses a simple `-wip` prerelease suffix for local versions so saves can
 * repeatedly overwrite the same prerelease without prompting.
 */

export const WIP_TIMESTAMP_TOKEN_LENGTH = 8;
export const WORKSPACE_HASH_TOKEN_LENGTH = 8;

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
  return version.includes(`${WIP_SUFFIX}.`) || version.endsWith(WIP_SUFFIX);
}

/**
 * Extract the base version from a local development version
 * Example: "1.2.3-wip" -> "1.2.3"
 */
export function extractBaseVersion(localVersion: string): string {
  const suffixIndex = localVersion.indexOf(WIP_SUFFIX);
  if (suffixIndex === -1) {
    return localVersion;
  }
  return localVersion.slice(0, suffixIndex);
}

const BASE62_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * Encode a non-negative integer into a fixed-length base62 string.
 * Values that exceed the requested length are truncated from the left (highest order digits).
 */
export function encodeBase62(value: number, length: number = WIP_TIMESTAMP_TOKEN_LENGTH): string {
  if (!Number.isFinite(value) || value < 0) {
    value = 0;
  }

  const base = BASE62_ALPHABET.length;
  let remaining = Math.floor(value);
  let encoded = '';

  do {
    const digit = remaining % base;
    encoded = `${BASE62_ALPHABET[digit]}${encoded}`;
    remaining = Math.floor(remaining / base);
  } while (remaining > 0);

  if (encoded.length < length) {
    encoded = encoded.padStart(length, '0');
  } else if (encoded.length > length) {
    encoded = encoded.slice(-length);
  }

  return encoded;
}

/**
 * Generate an 8-character base62 timestamp from the provided Date (defaults to now).
 */
export function generateBase62Timestamp(
  date: Date = new Date(),
  length: number = WIP_TIMESTAMP_TOKEN_LENGTH
): string {
  const seconds = Math.floor(date.getTime() / 1000);
  return encodeBase62(seconds, length);
}

/**
 * Create a deterministic hash for the current workspace path.
 * Returns a lower-case hex slice (default 8 characters).
 */
export function createWorkspaceHash(
  inputPath: string,
  length: number = WORKSPACE_HASH_TOKEN_LENGTH
): string {
  const normalizedPath = inputPath.replace(/\\/g, '/');
  const digest = createHash('sha256').update(normalizedPath).digest('hex');
  if (length <= 0) {
    return '';
  }
  if (digest.length <= length) {
    return digest.padEnd(length, '0');
  }
  return digest.slice(0, length);
}

export function sanitizeWorkspaceHash(
  hash: string,
  length: number = WORKSPACE_HASH_TOKEN_LENGTH
): string {
  const cleaned = (hash || '').toLowerCase().replace(/[^0-9a-z]/g, '');
  if (cleaned.length === 0) {
    return ''.padEnd(length, '0');
  }
  if (cleaned.length >= length) {
    return cleaned.slice(0, length);
  }
  return `${cleaned}${'0'.repeat(length - cleaned.length)}`;
}

export interface ParsedWipVersion {
  baseStable: string;
  timestamp: string;
  workspaceHash: string;
}

/**
 * Parse a WIP version string of the form {base}-wip.{timestamp}.{workspaceHash}
 */
export function parseWipVersion(version: string): ParsedWipVersion | null {
  const suffixIndex = version.indexOf(WIP_SUFFIX);
  if (suffixIndex === -1) {
    return null;
  }

  const baseStable = version.slice(0, suffixIndex);
  const afterSuffix = version.slice(suffixIndex + WIP_SUFFIX.length);
  if (!afterSuffix.startsWith('.')) {
    return null;
  }

  const parts = afterSuffix.slice(1).split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [timestamp, workspaceHash] = parts;
  if (!timestamp || !workspaceHash) {
    return null;
  }

  return {
    baseStable,
    timestamp,
    workspaceHash
  };
}

export function extractWorkspaceHashFromVersion(version: string): string | null {
  const parsed = parseWipVersion(version);
  return parsed?.workspaceHash ?? null;
}


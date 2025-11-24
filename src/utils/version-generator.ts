import { createHash } from 'crypto';
import * as semver from 'semver';
import { WIP_SUFFIX } from '../core/save/constants.js';

/**
 * Version generation utilities for local and WIP versions.
 */

export const WIP_TIMESTAMP_TOKEN_LENGTH = 6;
export const WORKSPACE_HASH_TOKEN_LENGTH = 8;
// Length of the short workspace tag used in WIP versions (e.g. 3 base36 chars)
export const WIP_WORKSPACE_TAG_LENGTH = 3;

/**
 * Generate a local development version using a simple `-wip` suffix.
 * Legacy helper used by older flows (e.g. interactive save) that predate
 * the S-<t>.<w> WIP scheme.
 *
 * Format: {baseVersion}-wip
 * Uses semver prerelease identifiers for proper version ordering.
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
 * Extract the stable base (major.minor.patch) portion of a version string.
 *
 * - For any valid semver (including pre-releases like "1.2.3-000fz8.a3k"
 *   or legacy "1.2.3-wip.abc"), this returns "1.2.3".
 * - For non-semver strings, it returns the portion before the first "-"
 *   (if any), otherwise the input unchanged.
 */
export function extractBaseVersion(version: string): string {
  const hyphenIndex = version.indexOf('-');
  const candidate = hyphenIndex === -1 ? version : version.slice(0, hyphenIndex);

  const parsed = semver.parse(candidate);
  if (parsed) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }
  return candidate;
}

const TIMESTAMP_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Encode a non-negative integer into a fixed-length base36-like string.
 * Values that exceed the requested length are truncated from the left (highest order digits).
 */
export function encodeBase62(value: number, length: number = WIP_TIMESTAMP_TOKEN_LENGTH): string {
  if (!Number.isFinite(value) || value < 0) {
    value = 0;
  }

  const base = TIMESTAMP_ALPHABET.length;
  let remaining = Math.floor(value);
  let encoded = '';

  do {
    const digit = remaining % base;
    encoded = `${TIMESTAMP_ALPHABET[digit]}${encoded}`;
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
 * Generate a 6-character base36 timestamp from the provided Date (defaults to now).
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

/**
 * Sanitize a workspace hash string to a fixed length.
 * Internal helper used for tag generation.
 */
function sanitizeWorkspaceHash(
  hash: string,
  length: number
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

/**
 * Create the workspace tag used in WIP versions.
 * Returns a 3-character tag derived from the workspace path hash.
 * This is the single source of truth for workspace tags used in version strings.
 */
export function createWorkspaceTag(inputPath: string): string {
  const workspaceHash = createWorkspaceHash(inputPath);
  return sanitizeWorkspaceHash(workspaceHash, WIP_WORKSPACE_TAG_LENGTH);
}

/**
 * Generate a WIP version string in the canonical S-<t>.<w> form.
 *
 * - `stable` is the normalized base stable version (e.g. "1.2.3").
 * - `workspacePath` is the workspace path; the tag is derived from it.
 * - `options.now` can be provided for deterministic testing.
 */
export function generateWipVersion(
  stable: string,
  workspacePath: string,
  options?: { now?: Date }
): string {
  const timestampPart = generateBase62Timestamp(
    options?.now ?? new Date(),
    WIP_TIMESTAMP_TOKEN_LENGTH
  );
  const hashPart = createWorkspaceTag(workspacePath);
  return `${stable}-${timestampPart}.${hashPart}`;
}

export interface ParsedWipVersion {
  baseStable: string;
  timestamp: string;
  workspaceHash: string;
}

/**
 * Parse a WIP version string.
 *
 * Supports:
 * - New scheme:  {base}-{timestamp}.{workspaceTag}  (e.g. 1.2.3-000fz8.a3k)
 * - Legacy scheme: {base}-wip.{timestamp}.{workspaceHash}
 */
export function parseWipVersion(version: string): ParsedWipVersion | null {
  const parsed = semver.parse(version);
  if (parsed && parsed.prerelease.length === 2) {
    const [timestamp, workspaceHash] = parsed.prerelease;
    if (typeof timestamp === 'string' && typeof workspaceHash === 'string') {
      return {
        baseStable: `${parsed.major}.${parsed.minor}.${parsed.patch}`,
        timestamp,
        workspaceHash
      };
    }
  }

  // Legacy {base}-wip.{timestamp}.{workspaceHash} support
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

  const [legacyTimestamp, legacyWorkspaceHash] = parts;
  if (!legacyTimestamp || !legacyWorkspaceHash) {
    return null;
  }

  return {
    baseStable,
    timestamp: legacyTimestamp,
    workspaceHash: legacyWorkspaceHash
  };
}

export function extractWorkspaceHashFromVersion(version: string): string | null {
  const parsed = parseWipVersion(version);
  return parsed?.workspaceHash ?? null;
}


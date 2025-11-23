import semver from 'semver';
import { ValidationError } from '../../utils/errors.js';
import {
  extractBaseVersion,
  generateBase62Timestamp,
  sanitizeWorkspaceHash,
  WIP_TIMESTAMP_TOKEN_LENGTH,
  WORKSPACE_HASH_TOKEN_LENGTH
} from '../../utils/version-generator.js';
import { ERROR_MESSAGES, WIP_SUFFIX } from './constants.js';

export interface WipVersionComputationResult {
  stable: string;
  wipVersion: string;
  lastWorkspaceVersion?: string;
  reset: boolean;
  resetMessage?: string;
}

export interface PackVersionComputationResult {
  baseStable: string;
  targetVersion: string;
  nextStable: string;
  lastWorkspaceVersion?: string;
  reset: boolean;
  resetMessage?: string;
}

export function computeWipVersion(
  baseStable: string,
  lastWorkspaceVersion: string | undefined,
  workspaceHash: string,
  options?: { now?: Date }
): WipVersionComputationResult {
  const normalizedStable = normalizeStableVersion(baseStable);
  const lastBase = lastWorkspaceVersion ? extractBaseVersion(lastWorkspaceVersion) : undefined;
  const reset = Boolean(lastWorkspaceVersion && lastBase !== normalizedStable);
  const resetMessage = reset
    ? `package.yml version ${normalizedStable} differs from last saved version ${lastWorkspaceVersion}. ` +
      `Resetting WIP stream to ${normalizedStable}${WIP_SUFFIX}.`
    : undefined;

  const timestampPart = generateBase62Timestamp(options?.now ?? new Date(), WIP_TIMESTAMP_TOKEN_LENGTH);
  const hashPart = sanitizeWorkspaceHash(workspaceHash, WORKSPACE_HASH_TOKEN_LENGTH);
  const wipVersion = `${normalizedStable}${WIP_SUFFIX}.${timestampPart}.${hashPart}`;

  return {
    stable: normalizedStable,
    wipVersion,
    lastWorkspaceVersion,
    reset,
    resetMessage
  };
}

export function computePackTargetVersion(
  baseStable: string,
  lastWorkspaceVersion?: string
): PackVersionComputationResult {
  const normalizedStable = normalizeStableVersion(baseStable);
  const lastBase = lastWorkspaceVersion ? extractBaseVersion(lastWorkspaceVersion) : undefined;
  const reset = Boolean(lastWorkspaceVersion && lastBase !== normalizedStable);
  const resetMessage = reset
    ? `package.yml version ${normalizedStable} differs from last packed version ${lastWorkspaceVersion}. ` +
      `Promoting ${normalizedStable} as the next stable release.`
    : undefined;

  const nextStable = bumpStableVersion(normalizedStable, 'patch');

  return {
    baseStable: normalizedStable,
    targetVersion: normalizedStable,
    nextStable,
    lastWorkspaceVersion,
    reset,
    resetMessage
  };
}

function normalizeStableVersion(version: string): string {
  const base = extractBaseVersion(version);
  const normalized = semver.valid(base);
  if (!normalized) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_VERSION_FORMAT.replace('%s', version));
  }
  return normalized;
}

function bumpStableVersion(baseStable: string, bump: 'patch' | 'minor' | 'major'): string {
  const next = semver.inc(baseStable, bump);
  if (!next) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_VERSION_FORMAT.replace('%s', baseStable));
  }
  return next;
}


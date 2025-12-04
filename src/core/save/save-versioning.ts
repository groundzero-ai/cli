import semver from 'semver';
import { ValidationError } from '../../utils/errors.js';
import {
  extractBaseVersion,
  generateWipVersion
} from '../../utils/version-generator.js';
import { ERROR_MESSAGES } from './constants.js';

export interface WipVersionComputationResult {
  /**
   * The normalized stable base declared in package.yml (e.g. "1.2.3").
   */
  stable: string;
  /**
   * The effective stable base actually used to generate the WIP version.
   * Normally this equals `stable`, but when the last workspace version is a
   * non-prerelease `stable`, this is bumped to `patch(stable)` to start the
   * next development cycle.
   */
  effectiveStable: string;
  /**
   * The computed WIP version string (e.g. "1.2.4-000fz8.a3k").
   */
  wipVersion: string;
  /**
   * The last recorded workspace version from the package index file, if any.
   */
  lastWorkspaceVersion?: string;
  /**
   * True when the last workspace version's base differs from `stable`,
   * indicating a reset to a new version line.
   */
  reset: boolean;
  /**
   * Optional human-readable reset message.
   */
  resetMessage?: string;
  /**
   * When true, callers may choose to auto-bump package.yml.version from
   * `stable` to `nextStable` after a successful save.
   */
  shouldBumpPackageYml: boolean;
  /**
   * The next stable version that package.yml.version should be bumped to
   * when `shouldBumpPackageYml` is true.
   */
  nextStable?: string;
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
  workspacePath: string,
  options?: { now?: Date }
): WipVersionComputationResult {
  const normalizedStable = normalizeStableVersion(baseStable);
  const lastBase = lastWorkspaceVersion ? extractBaseVersion(lastWorkspaceVersion) : undefined;
  const reset = Boolean(lastWorkspaceVersion && lastBase !== normalizedStable);
  const resetMessage = reset
    ? `package.yml version ${normalizedStable} differs from last saved version ${lastWorkspaceVersion}. ` +
      `Resetting WIP stream for ${normalizedStable}.`
    : undefined;

  // Determine whether the last workspace version represents a packed/installed
  // stable. Only when it is a non-prerelease semver whose base matches
  // package.yml.version do we start a new WIP stream from patch(stable).
  let effectiveStable = normalizedStable;
  let shouldBumpPackageYml = false;
  let nextStable: string | undefined;

  if (!reset && lastWorkspaceVersion) {
    const parsedLast = semver.parse(lastWorkspaceVersion);
    const isStableLast = Boolean(parsedLast && parsedLast.prerelease.length === 0);

    if (isStableLast) {
      // lastWorkspaceVersion is a stable S on the same base line as package.yml.
      // Begin the next development cycle from patch(S).
      nextStable = bumpStableVersion(normalizedStable, 'patch');
      effectiveStable = nextStable;
      shouldBumpPackageYml = true;
    }
  }

  const wipVersion = generateWipVersion(effectiveStable, workspacePath, options);

  return {
    stable: normalizedStable,
    effectiveStable,
    wipVersion,
    lastWorkspaceVersion,
    reset,
    resetMessage,
    shouldBumpPackageYml,
    nextStable
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


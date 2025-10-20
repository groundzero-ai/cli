import { ValidationError } from "../../utils/errors.js";
import { extractBaseVersion, generateLocalVersion, isLocalVersion } from "../../utils/version-generator.js";
import { ERROR_MESSAGES, LOG_PREFIXES, DEFAULT_VERSION, VERSION_TYPE_STABLE } from "./constants.js";

const BUMP_TYPES = {
  PATCH: 'patch',
  MINOR: 'minor',
  MAJOR: 'major'
} as const;

type BumpType = typeof BUMP_TYPES[keyof typeof BUMP_TYPES];

/**
 * Bump version to prerelease (default behavior for --bump)
 * @param version - The current version string
 * @param bumpType - The type of bump to apply
 * @returns A new prerelease version string
 */
function bumpToPrerelease(version: string, bumpType: BumpType): string {
  const baseVersion = extractBaseVersion(version);
  const bumpedBase = calculateBumpedVersion(baseVersion, bumpType);
  return generateLocalVersion(bumpedBase);
}

/**
 * Bump version to stable (when combined with 'stable' argument)
 * @param version - The current version string
 * @param bumpType - The type of bump to apply
 * @returns A new stable version string
 */
function bumpToStable(version: string, bumpType: BumpType): string {
  const baseVersion = extractBaseVersion(version);
  return calculateBumpedVersion(baseVersion, bumpType);
}

/**
 * Calculate bumped version based on type (stable output)
 * @param version - The base version string to bump
 * @param bumpType - The type of bump to apply ('patch', 'minor', or 'major')
 * @returns The bumped version string
 * @throws ValidationError if version format is invalid or bump type is unknown
 */
function calculateBumpedVersion(version: string, bumpType: BumpType): string {
  // Extract base version (remove any prerelease identifiers and build metadata)
  const baseVersion = version.split('-')[0].split('+')[0];
  const parts = baseVersion.split('.').map(Number);

  // Validate that we have valid numbers
  if (parts.some(isNaN)) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_VERSION_FORMAT.replace('%s', version));
  }

  switch (bumpType) {
    case 'patch':
      return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2] + 1}` : baseVersion;
    case 'minor':
      return parts.length >= 2 ? `${parts[0]}.${parts[1] + 1}.0` : baseVersion;
    case 'major':
      return parts.length >= 1 ? `${parts[0] + 1}.0.0` : baseVersion;
    default:
      throw new ValidationError(ERROR_MESSAGES.INVALID_BUMP_TYPE.replace('%s', bumpType));
  }
}


/**
 * Determine target version based on input, version type, and options
 */
export async function determineTargetVersion(
  explicitVersion?: string,
  versionType?: string,
  bump?: 'patch' | 'minor' | 'major',
  currentVersion?: string
): Promise<string> {
  if (explicitVersion) {
    console.log(`${LOG_PREFIXES.EXPLICIT_VERSION} ${explicitVersion}`);
    return explicitVersion;
  }

  if (!currentVersion) {
    const prereleaseVersion = generateLocalVersion(DEFAULT_VERSION);
    console.log(`${LOG_PREFIXES.PRERELEASE} ${prereleaseVersion}`);
    return prereleaseVersion;
  }

  if (bump) {
    if (versionType === VERSION_TYPE_STABLE) {
      const bumpedVersion = bumpToStable(currentVersion, bump);
      console.log(`${LOG_PREFIXES.BUMP_STABLE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${bumpedVersion}`);
      return bumpedVersion;
    } else {
      const bumpedVersion = bumpToPrerelease(currentVersion, bump);
      console.log(`${LOG_PREFIXES.BUMP_PRERELEASE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${bumpedVersion}`);
      return bumpedVersion;
    }
  }

  if (versionType === VERSION_TYPE_STABLE) {
    if (isLocalVersion(currentVersion)) {
      const stableVersion = extractBaseVersion(currentVersion);
      console.log(`${LOG_PREFIXES.CONVERT_STABLE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${stableVersion}`);
      return stableVersion;
    } else {
      // Already stable - auto bump to next patch version
      const nextStable = calculateBumpedVersion(currentVersion, 'patch');
      console.log(`${LOG_PREFIXES.BUMP_STABLE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${nextStable}`);
      return nextStable;
    }
  }

  // Default smart increment behavior
  if (isLocalVersion(currentVersion)) {
    const localVersion = generateLocalVersion(extractBaseVersion(currentVersion));
    console.log(`${LOG_PREFIXES.INCREMENT_PRERELEASE} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${localVersion}`);
    return localVersion;
  } else {
    // For other stable versions, bump patch and then generate prerelease
    const nextPatchVersion = calculateBumpedVersion(currentVersion, 'patch');
    const localVersion = generateLocalVersion(nextPatchVersion);
    console.log(`${LOG_PREFIXES.AUTO_INCREMENT} ${currentVersion} ${LOG_PREFIXES.ARROW_SEPARATOR} ${localVersion}`);
    return localVersion;
  }
}
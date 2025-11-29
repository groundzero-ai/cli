import { FILE_PATTERNS } from '../constants/index.js';
import { getPlatformDefinition, type Platform } from '../core/platforms.js';

function joinSegments(segments: string[]): string {
  return segments.filter(Boolean).join('/');
}

/**
 * Append a platform suffix to the basename of a registry path.
 * Examples:
 * - rules/auth.md -> rules/auth.<platform>.md
 * - rules/helpers/index.ts -> rules/helpers/index.<platform>.ts
 */
export function suffixFileBasename(registryPath: string, platform: Platform): string {
  const segments = registryPath.split('/');
  const fileName = segments.pop();

  if (!fileName) {
    return registryPath;
  }

  const lastDotIndex = fileName.lastIndexOf('.');

  if (lastDotIndex <= 0) {
    if (!fileName.endsWith(`.${platform}`)) {
      segments.push(`${fileName}.${platform}`);
    } else {
      segments.push(fileName);
    }
    return joinSegments(segments);
  }

  const name = fileName.slice(0, lastDotIndex);
  const ext = fileName.slice(lastDotIndex);

  if (name.endsWith(`.${platform}`)) {
    segments.push(fileName);
    return joinSegments(segments);
  }

  segments.push(`${name}.${platform}${ext}`);
  return joinSegments(segments);
}

/**
 * Apply a platform suffix to the first content directory within a registry path.
 * Example: rules/helpers/foo.md -> rules/helpers.<platform>/foo.md
 */
export function suffixFirstContentDir(registryPath: string, platform: Platform): string {
  const segments = registryPath.split('/');
  if (segments.length < 2) {
    return registryPath;
  }

  const subdir = segments[0];
  const rest = segments.slice(1);

  if (rest.length === 0) {
    return registryPath;
  }

  if (!rest[0].endsWith(`.${platform}`)) {
    rest[0] = `${rest[0]}.${platform}`;
  }

  return joinSegments([subdir, ...rest]);
}

/**
 * Build a platform-specific registry path for a universal registry path.
 * Handles root files and markdown suffix insertion.
 * Returns null when the platform should not emit a specific variant (e.g., missing root file).
 */
export function createPlatformSpecificRegistryPath(
  registryPath: string,
  platform: Platform
): string | null {
  const segments = registryPath.split('/');
  const fileName = segments[segments.length - 1];
  const isRoot = segments.length === 1;

  if (!fileName) {
    return registryPath;
  }

  if (isRoot) {
    const definition = getPlatformDefinition(platform);

    if (definition?.rootFile) {
      return definition.rootFile;
    }

    // If the platform does not define a native root file, skip emitting a platform-specific variant.
    return null;
  }

  if (registryPath.endsWith(FILE_PATTERNS.MD_FILES)) {
    return suffixFileBasename(registryPath, platform);
  }

  return suffixFileBasename(registryPath, platform);
}


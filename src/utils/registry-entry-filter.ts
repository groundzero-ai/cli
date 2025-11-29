import {
  DIR_PATTERNS,
  FILE_PATTERNS,
  UNIVERSAL_SUBDIRS
} from '../constants/index.js';
import { getFirstPathComponent, normalizePathForProcessing } from './path-normalization.js';
import { getAllRootFiles, isPlatformId } from '../core/platforms.js';

const ROOT_REGISTRY_FILE_NAMES = getAllRootFiles();

export function normalizeRegistryPath(registryPath: string): string {
  return normalizePathForProcessing(registryPath);
}

export function isRootRegistryPath(registryPath: string): boolean {
  const normalized = normalizeRegistryPath(registryPath);
  return ROOT_REGISTRY_FILE_NAMES.some(pattern =>
    normalized.endsWith(`/${pattern}`) || normalized === pattern
  );
}

export function isSkippableRegistryPath(registryPath: string): boolean {
  const normalized = normalizeRegistryPath(registryPath);
  if (normalized === FILE_PATTERNS.PACKAGE_YML) {
    return true;
  }

  const universalValues: string[] = Object.values(UNIVERSAL_SUBDIRS as Record<string, string>);

  if (!universalValues.some(subdir => normalized.startsWith(`${subdir}/`))) {
    return false;
  }

  if (!normalized.endsWith(FILE_PATTERNS.YML_FILE)) {
    return false;
  }

  const lastDot = normalized.lastIndexOf('.');
  const secondLastDot = normalized.lastIndexOf('.', lastDot - 1);

  if (secondLastDot === -1) {
    return false;
  }

  const possiblePlatform = normalized.slice(secondLastDot + 1, lastDot);
  return isPlatformId(possiblePlatform);
}

export function isAllowedRegistryPath(registryPath: string): boolean {
  const normalized = normalizeRegistryPath(registryPath);

  if (isRootRegistryPath(normalized)) {
    return false;
  }

  if (isSkippableRegistryPath(normalized)) {
    return false;
  }

  const universalValues: string[] = Object.values(UNIVERSAL_SUBDIRS as Record<string, string>);
  const firstComponent = getFirstPathComponent(normalized);
  const isAi = firstComponent === DIR_PATTERNS.AI;
  const isUniversal = universalValues.includes(firstComponent);

  return isAi || isUniversal;
}



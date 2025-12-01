import {
  DIR_PATTERNS,
  FILE_PATTERNS,
  UNIVERSAL_SUBDIRS
} from '../constants/index.js';
import {
  getFirstPathComponent,
  getPathAfterFirstComponent,
  normalizePathForProcessing
} from './path-normalization.js';
import { getAllRootFiles, isPlatformId } from '../core/platforms.js';

const ROOT_REGISTRY_FILE_NAMES = getAllRootFiles();
const UNIVERSAL_VALUES: string[] = Object.values(UNIVERSAL_SUBDIRS as Record<string, string>);
const OPENPACKAGE_PREFIX = `${DIR_PATTERNS.OPENPACKAGE}/`;

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

  const universalInfo = extractUniversalSubdirInfo(normalized);
  if (!universalInfo) {
    return false;
  }

  const normalizedRel = normalizePathForProcessing(universalInfo.relPath);
  if (!normalizedRel.endsWith(FILE_PATTERNS.YML_FILE)) {
    return false;
  }

  const fileName = normalizedRel.split('/').pop();
  if (!fileName) {
    return false;
  }

  const parts = fileName.split('.');
  if (parts.length < 3) {
    return false;
  }

  const possiblePlatform = parts[parts.length - 2];
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

  return true;
}

export function extractUniversalSubdirInfo(
  registryPath: string
): { universalSubdir: string; relPath: string } | null {
  const normalized = normalizeRegistryPath(registryPath);
  if (!normalized.startsWith(OPENPACKAGE_PREFIX)) {
    return null;
  }

  const afterPrefix = normalized.slice(OPENPACKAGE_PREFIX.length);
  const firstComponent = getFirstPathComponent(afterPrefix);

  if (!firstComponent || !UNIVERSAL_VALUES.includes(firstComponent)) {
    return null;
  }

  const relPath = getPathAfterFirstComponent(afterPrefix) ?? '';
  return {
    universalSubdir: firstComponent,
    relPath
  };
}



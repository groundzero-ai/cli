import { DIR_PATTERNS, UNIVERSAL_SUBDIRS } from '../constants/index.js';

export function formatRegistryPathForDisplay(registryPath: string): string {
  const universalValues: string[] = Object.values(UNIVERSAL_SUBDIRS as Record<string, string>);
  const firstComponent = registryPath.split('/')[0];

  if (firstComponent && universalValues.includes(firstComponent)) {
    return `${DIR_PATTERNS.OPENPACKAGE}/${registryPath}`;
  }

  return registryPath;
}



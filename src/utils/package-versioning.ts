import * as semver from 'semver';
import yaml from 'js-yaml';
import { PackageFile, PackageYml } from '../types/index.js';
import { extractBaseVersion } from './version-generator.js';
import { getPackageVersionPath } from '../core/directory.js';
import { exists } from './fs.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { isScopedName } from '../core/scoping/package-scoping.js';

/**
 * Compute stable version from a prerelease version
 * Example: "1.2.3-dev.abc123" -> "1.2.3"
 */
export function computeStableVersion(version: string): string {
  const parsed = semver.parse(version);
  if (parsed) {
    return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  }
  return extractBaseVersion(version);
}

/**
 * Dump YAML with proper quoting for scoped names (e.g., @scope/name)
 */
export function dumpYamlWithScopedQuoting(config: PackageYml, options: yaml.DumpOptions = {}): string {
  let dumped = yaml.dump(config, { ...options, quotingType: '"' });
  
  // Ensure scoped names are quoted
  if (isScopedName(config.name)) {
    const lines = dumped.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('name:')) {
        const valueMatch = lines[i].match(/name:\s*(.+)$/);
        if (valueMatch) {
          const value = valueMatch[1].trim();
          if (!value.startsWith('"') && !value.startsWith("'")) {
            lines[i] = lines[i].replace(/name:\s*(.+)$/, `name: "${config.name}"`);
          }
        }
        break;
      }
    }
    dumped = lines.join('\n');
  }
  
  return dumped;
}

/**
 * Transform package files for version change only (no name change)
 * Updates package.yml version field
 */
export function transformPackageFilesForVersionChange(
  files: PackageFile[],
  newVersion: string,
  packageName: string
): PackageFile[] {
  return files.map((file) => {
    if (file.path === FILE_PATTERNS.PACKAGE_YML) {
      try {
        const parsed = yaml.load(file.content) as PackageYml;
        const updated: PackageYml = {
          ...parsed,
          version: newVersion
        };
        const dumped = dumpYamlWithScopedQuoting(updated, { lineWidth: 120 });
        return { ...file, content: dumped };
      } catch {
        // Fallback: minimal rewrite if parsing fails
        const fallback: PackageYml = {
          name: packageName,
          version: newVersion
        };
        const dumped = dumpYamlWithScopedQuoting(fallback, { lineWidth: 120 });
        return { ...file, content: dumped };
      }
    }
    return file;
  });
}

/**
 * Transform package files metadata for name and version changes
 * Updates package.yml only
 */
export function transformPackageFilesMetadata(
  files: PackageFile[],
  sourceName: string,
  newName: string,
  newVersion: string
): PackageFile[] {
  return files.map((file) => {
    // Update package.yml
    if (file.path === FILE_PATTERNS.PACKAGE_YML) {
      try {
        const parsed = yaml.load(file.content) as PackageYml;
        const updated: PackageYml = {
          ...parsed,
          name: newName,
          version: newVersion
        };
        const dumped = dumpYamlWithScopedQuoting(updated, { lineWidth: 120 });
        return { ...file, content: dumped };
      } catch {
        // Fallback: minimal rewrite if parsing fails
        const fallback: PackageYml = {
          name: newName,
          version: newVersion
        };
        const dumped = dumpYamlWithScopedQuoting(fallback, { lineWidth: 120 });
        return { ...file, content: dumped };
      }
    }

    return file;
  });
}

/**
 * Check if a package version already exists
 */
export async function packageVersionExists(packageName: string, version: string): Promise<boolean> {
  const targetPath = getPackageVersionPath(packageName, version);
  return await exists(targetPath);
}

/**
 * Filter a list of versions down to semver-valid stable releases.
 */
export function filterStableVersions(versions: string[]): string[] {
  return versions.filter((version) => semver.valid(version) && !semver.prerelease(version));
}

/**
 * Find the latest stable version from a list (returns null if none).
 */
export function getLatestStableVersion(versions: string[]): string | null {
  const stableVersions = filterStableVersions(versions);
  if (stableVersions.length === 0) {
    return null;
  }
  return semver.rsort(stableVersions)[0];
}


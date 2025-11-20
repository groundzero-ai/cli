import type { PackageFile } from '../types/index.js';
import { FILE_PATTERNS } from '../constants/index.js';
import {
  exists,
  isDirectory,
  readTextFile
} from './fs.js';
import { findFilesByExtension } from './file-processing.js';
import { FORMULA_INDEX_FILENAME } from './package-index-yml.js';
import {
  isAllowedRegistryPath,
  isRootRegistryPath,
  isSkippableRegistryPath,
  normalizeRegistryPath
} from './registry-entry-filter.js';

const UTF8_ENCODING = 'utf8';

export async function readLocalPackageFilesForIndex(formulaDir: string): Promise<PackageFile[]> {
  if (!(await exists(formulaDir)) || !(await isDirectory(formulaDir))) {
    return [];
  }

  const entries = await findFilesByExtension(formulaDir, [], formulaDir);
  const files: PackageFile[] = [];

  for (const entry of entries) {
    const normalizedPath = normalizeRegistryPath(entry.relativePath);

    if (normalizedPath === FORMULA_INDEX_FILENAME) {
      continue;
    }

    const isAllowed = isAllowedRegistryPath(normalizedPath);
    const isRoot = isRootRegistryPath(normalizedPath);
    const isYamlOverride = isYamlOverrideFile(normalizedPath);
    const isPackageYml = normalizedPath === FILE_PATTERNS.FORMULA_YML;
    const isRootLevelFile = !normalizedPath.includes('/');

    if (!isAllowed && !isRoot && !isYamlOverride && !isPackageYml && !isRootLevelFile) {
      continue;
    }

    const content = await readTextFile(entry.fullPath, UTF8_ENCODING);
    files.push({
      path: normalizedPath,
      content,
      encoding: UTF8_ENCODING
    });
  }

  return files;
}

function isYamlOverrideFile(normalizedPath: string): boolean {
  return normalizedPath !== FILE_PATTERNS.FORMULA_YML && isSkippableRegistryPath(normalizedPath);
}


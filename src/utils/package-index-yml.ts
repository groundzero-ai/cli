import { join, dirname } from 'path';
import * as yaml from 'js-yaml';
import { exists, readTextFile, writeTextFile, ensureDir } from './fs.js';
import { getLocalPackageDir } from './paths.js';
import { normalizePathForProcessing } from './path-normalization.js';
import { logger } from './logger.js';

export const PACKAGE_INDEX_FILENAME = 'package.index.yml';
const HEADER_COMMENT = '# This file is managed by OpenPackage. Do not edit manually.';

export interface PackageIndexWorkspace {
  hash?: string;
  version: string;
}

export interface PackageIndexData {
  workspace: PackageIndexWorkspace;
  files: Record<string, string[]>;
}

export interface PackageIndexRecord extends PackageIndexData {
  path: string;
  packageName: string;
}

export function getPackageIndexPath(cwd: string, packageName: string): string {
  const packageDir = getLocalPackageDir(cwd, packageName);
  return join(packageDir, PACKAGE_INDEX_FILENAME);
}

export function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

export function sortMapping(record: Record<string, string[]>): Record<string, string[]> {
  const sortedKeys = Object.keys(record).sort();
  const normalized: Record<string, string[]> = {};
  for (const key of sortedKeys) {
    const values = record[key] || [];
    const sortedValues = [...new Set(values)].sort();
    normalized[key] = sortedValues;
  }
  return normalized;
}

export function sanitizeIndexData(data: any): PackageIndexData | null {
  if (!data || typeof data !== 'object') return null;

  let workspaceVer: string | undefined;
  let workspaceHash: string | undefined;

  const workspaceSection = (data as { workspace?: unknown }).workspace;
  if (workspaceSection && typeof workspaceSection === 'object') {
    const maybeVersion = (workspaceSection as { version?: unknown }).version;
    if (typeof maybeVersion === 'string') {
      workspaceVer = maybeVersion;
    }
    const maybeHash = (workspaceSection as { hash?: unknown }).hash;
    if (typeof maybeHash === 'string') {
      workspaceHash = maybeHash;
    }
  }

  if (typeof workspaceVer !== 'string') return null;

  const files = (data as { files?: unknown }).files;
  if (!files || typeof files !== 'object') return null;

  const entries: Record<string, string[]> = {};
  for (const [rawKey, rawValue] of Object.entries(files as Record<string, unknown>)) {
    if (typeof rawKey !== 'string') continue;
    if (!Array.isArray(rawValue)) continue;

    const cleanedValues = rawValue
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(value => normalizePathForProcessing(value));

    entries[normalizePathForProcessing(rawKey)] = cleanedValues;
  }

  return {
    workspace: {
      version: workspaceVer,
      hash: workspaceHash
    },
    files: sortMapping(entries)
  };
}

export async function readPackageIndex(cwd: string, packageName: string): Promise<PackageIndexRecord | null> {
  const indexPath = getPackageIndexPath(cwd, packageName);
  if (!(await exists(indexPath))) {
    return null;
  }

  try {
    const content = await readTextFile(indexPath);
    const parsed = yaml.load(content) as any;
    const sanitized = sanitizeIndexData(parsed);
    if (!sanitized) {
      logger.warn(`Invalid package index detected at ${indexPath}, will repair on write.`);
      return {
        path: indexPath,
        packageName,
        workspace: { version: '', hash: undefined },
        files: {}
      };
    }
    return {
      path: indexPath,
      packageName,
      workspace: sanitized.workspace,
      files: sanitized.files
    };
  } catch (error) {
    logger.warn(`Failed to read package index at ${indexPath}: ${error}`);
    return {
      path: indexPath,
      packageName,
      workspace: { version: '', hash: undefined },
      files: {}
    };
  }
}

export async function writePackageIndex(record: PackageIndexRecord): Promise<void> {
  const { path: indexPath, files } = record;
  const workspaceVer = record.workspace?.version;
  if (!workspaceVer) {
    throw new Error('workspace.version is required when writing package.index.yml');
  }
  const workspace: PackageIndexWorkspace = {
    hash: record.workspace?.hash,
    version: workspaceVer
  };
  await ensureDir(dirname(indexPath));

  const normalizedFiles = sortMapping(files);
  const body = yaml.dump(
    {
      workspace,
      files: normalizedFiles
    },
    {
      lineWidth: 120,
      sortKeys: true
    }
  );

  const serialized = `${HEADER_COMMENT}\n\n${body}`;
  await writeTextFile(indexPath, serialized);
}

export function isDirKey(key: string): boolean {
  return key.endsWith('/');
}

/**
 * Prune nested child directories if their parent directory is already present.
 * Example: keep "skills/nestjs/" and drop "skills/nestjs/examples/".
 */
export function pruneNestedDirectories(dirs: string[]): string[] {
  const sorted = [...dirs].sort((a, b) => {
    if (a.length === b.length) {
      return a.localeCompare(b);
    }
    return a.length - b.length;
  });

  const pruned: string[] = [];
  for (const dir of sorted) {
    const hasParent = pruned.some(parent => dir !== parent && dir.startsWith(parent));
    if (!hasParent) {
      pruned.push(dir);
    }
  }
  return pruned;
}

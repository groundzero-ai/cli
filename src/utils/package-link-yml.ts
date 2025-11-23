import { join } from 'path';
import yaml from 'js-yaml';
import { ensureDir, exists, readTextFile, writeTextFile, remove, listDirectories } from './fs.js';
import { getPackagePath, getPackageVersionPath } from '../core/directory.js';
import { logger } from './logger.js';
import { extractWorkspaceHashFromVersion } from './version-generator.js';

export const PACKAGE_LINK_FILENAME = 'package.link.yml';

export interface PackageLinkMetadata {
  sourcePath: string;
}

export interface PackageLinkEntry {
  version: string;
  path: string;
  metadata: PackageLinkMetadata;
}

export function getPackageLinkPath(packageName: string, version: string): string {
  return join(getPackageVersionPath(packageName, version), PACKAGE_LINK_FILENAME);
}

export async function writePackageLink(
  packageName: string,
  version: string,
  metadata: PackageLinkMetadata
): Promise<void> {
  const versionPath = getPackageVersionPath(packageName, version);
  await ensureDir(versionPath);

  const linkPath = getPackageLinkPath(packageName, version);
  const serialized = yaml.dump(
    {
      sourcePath: metadata.sourcePath
    },
    {
      lineWidth: 120,
      sortKeys: true
    }
  );

  await writeTextFile(linkPath, serialized);
  logger.debug(`Updated package link metadata`, { packageName, version, linkPath });
}

export async function readPackageLink(packageName: string, version: string): Promise<PackageLinkMetadata | null> {
  const linkPath = getPackageLinkPath(packageName, version);
  if (!(await exists(linkPath))) {
    return null;
  }

  try {
    const content = await readTextFile(linkPath);
    const parsed = yaml.load(content) as any;
    const metadata = sanitizeLinkMetadata(parsed, version);
    return metadata;
  } catch (error) {
    logger.warn(`Failed to read package link for ${packageName}@${version}: ${error}`);
    return null;
  }
}

export async function listPackageLinks(packageName: string): Promise<PackageLinkEntry[]> {
  const packagePath = getPackagePath(packageName);
  if (!(await exists(packagePath))) {
    return [];
  }

  const versions = await listDirectories(packagePath).catch(() => [] as string[]);
  const entries: PackageLinkEntry[] = [];

  for (const version of versions) {
    const metadata = await readPackageLink(packageName, version);
    if (!metadata) {
      continue;
    }
    const linkPath = getPackageLinkPath(packageName, version);
    entries.push({ version, path: linkPath, metadata });
  }

  return entries.sort((a, b) => a.version.localeCompare(b.version));
}

export async function deletePackageLink(packageName: string, version: string): Promise<void> {
  const versionPath = getPackageVersionPath(packageName, version);
  try {
    await remove(versionPath);
  } catch (error) {
    logger.warn(`Failed to delete package link directory ${versionPath}: ${error}`);
  }
}

export async function deleteWorkspaceLinks(
  packageName: string,
  workspaceHash: string,
  options: { keepVersion?: string } = {}
): Promise<void> {
  const normalizedHash = workspaceHash.toLowerCase();
  const links = await listPackageLinks(packageName);

  for (const entry of links) {
    if (options.keepVersion && entry.version === options.keepVersion) {
      continue;
    }
    const entryWorkspaceHash = extractWorkspaceHashFromVersion(entry.version);
    if (!entryWorkspaceHash || entryWorkspaceHash.toLowerCase() !== normalizedHash) {
      continue;
    }
    await deletePackageLink(packageName, entry.version);
  }
}

function sanitizeLinkMetadata(raw: any, fallbackVersion: string): PackageLinkMetadata | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const sourcePath = typeof raw.sourcePath === 'string' ? raw.sourcePath : '';

  if (!sourcePath) {
    return null;
  }

  return {
    sourcePath
  };
}


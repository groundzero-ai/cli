import { FILE_PATTERNS, PACKAGE_PATHS } from '../../constants/index.js';
import { findFilesByExtension, getFileMtime } from '../../utils/file-processing.js';
import { readTextFile } from '../../utils/fs.js';
import { calculateFileHash } from '../../utils/hash-utils.js';
import {
  isAllowedRegistryPath,
  normalizeRegistryPath
} from '../../utils/registry-entry-filter.js';
import { getRelativePathFromBase } from '../../utils/path-normalization.js';
import { splitFrontmatter, stripFrontmatter } from '../../utils/markdown-frontmatter.js';
import { discoverPlatformFilesUnified } from '../discovery/platform-files-discovery.js';
import { inferPlatformFromWorkspaceFile } from '../platforms.js';
import type { SaveCandidate } from './save-types.js';

export async function loadLocalCandidates(packageDir: string): Promise<SaveCandidate[]> {
  const entries = await findFilesByExtension(packageDir, [], packageDir);

  const candidates: SaveCandidate[] = [];

  for (const entry of entries) {
    const normalizedPath = normalizeRegistryPath(entry.relativePath);

    if (
      normalizedPath === FILE_PATTERNS.PACKAGE_INDEX_YML ||
      normalizedPath === PACKAGE_PATHS.INDEX_RELATIVE
    ) {
      continue;
    }

    if (normalizedPath === FILE_PATTERNS.AGENTS_MD) {
      continue;
    }

    if (!isAllowedRegistryPath(normalizedPath)) {
      continue;
    }

    const fullPath = entry.fullPath;
    const content = await readTextFile(fullPath);
    const isMarkdown = normalizedPath.endsWith(FILE_PATTERNS.MD_FILES);
    const split = isMarkdown ? splitFrontmatter(content) : undefined;
    const markdownBody = split ? split.body : content;
    const frontmatter = split?.frontmatter ?? undefined;
    const rawFrontmatter = split?.rawFrontmatter;
    const contentHash = await calculateContentHash(normalizedPath, content);
    const mtime = await getFileMtime(fullPath);

    candidates.push({
      source: 'local',
      registryPath: normalizedPath,
      fullPath,
      content,
      contentHash,
      mtime,
      displayPath: normalizedPath,
      isMarkdown,
      frontmatter,
      rawFrontmatter,
      markdownBody
    });
  }

  return candidates;
}

export async function discoverWorkspaceCandidates(
  cwd: string,
  packageName: string
): Promise<SaveCandidate[]> {
  const discovered = await discoverPlatformFilesUnified(cwd, packageName);

  const candidates: SaveCandidate[] = [];

  for (const file of discovered) {
    const normalizedPath = normalizeRegistryPath(file.registryPath);

    if (!isAllowedRegistryPath(normalizedPath)) {
      continue;
    }

    const content = await readTextFile(file.fullPath);
    const isMarkdown = normalizedPath.endsWith(FILE_PATTERNS.MD_FILES);
    const split = isMarkdown ? splitFrontmatter(content) : undefined;
    const markdownBody = split ? split.body : content;
    const frontmatter = split?.frontmatter ?? undefined;
    const rawFrontmatter = split?.rawFrontmatter;
    const contentHash = await calculateContentHash(normalizedPath, content);
    const displayPath = getRelativePathFromBase(file.fullPath, cwd) || normalizedPath;
    const platform = inferPlatformFromWorkspaceFile(file.fullPath, file.sourceDir, normalizedPath);

    candidates.push({
      source: 'workspace',
      registryPath: normalizedPath,
      fullPath: file.fullPath,
      content,
      contentHash,
      mtime: file.mtime,
      displayPath,
      platform,
      isMarkdown,
      frontmatter,
      rawFrontmatter,
      markdownBody
    });
  }

  return candidates;
}

async function calculateContentHash(registryPath: string, content: string): Promise<string> {
  const isMarkdown = registryPath.endsWith(FILE_PATTERNS.MD_FILES);
  const normalizedContent = isMarkdown ? stripFrontmatter(content) : content;
  return await calculateFileHash(normalizedContent);
}



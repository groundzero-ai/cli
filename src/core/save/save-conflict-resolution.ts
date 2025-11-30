import { dirname, join } from 'path';
import type { PackageFile } from '../../types/index.js';
import type { PackageYmlInfo } from './package-yml-generator.js';
import { FILE_PATTERNS } from '../../constants/index.js';
import { PACKAGE_INDEX_FILENAME, readPackageIndex, isDirKey } from '../../utils/package-index-yml.js';
import { getLocalPackageDir } from '../../utils/paths.js';
import { ensureDir, exists, isDirectory, readTextFile, writeTextFile } from '../../utils/fs.js';
import { findFilesByExtension } from '../../utils/file-processing.js';
import {
  isAllowedRegistryPath,
  normalizeRegistryPath,
  isRootRegistryPath,
  isSkippableRegistryPath
} from '../../utils/registry-entry-filter.js';
import { UTF8_ENCODING } from './constants.js';
import { createPlatformSpecificRegistryPath } from '../../utils/platform-specific-paths.js';
import { logger } from '../../utils/logger.js';
import { SaveCandidate } from './save-types.js';
import {
  discoverWorkspaceRootSaveCandidates,
  loadLocalRootSaveCandidates
} from './root-save-candidates.js';
import {
  buildFrontmatterMergePlans,
  applyFrontmatterMergePlans,
  type SaveCandidateGroup
} from './save-yml-resolution.js';
import { loadLocalCandidates, discoverWorkspaceCandidates } from './save-candidate-loader.js';
import {
  buildCandidateGroups,
  pruneWorkspaceCandidatesWithLocalPlatformVariants,
  resolveGroup,
  resolveRootGroup
} from './save-conflict-resolver.js';

export interface SaveConflictResolutionOptions {
  force?: boolean;
}

export async function resolvePackageFilesWithConflicts(
  packageInfo: PackageYmlInfo,
  options: SaveConflictResolutionOptions = {}
): Promise<PackageFile[]> {
  const cwd = process.cwd();
  const packageDir = getLocalPackageDir(cwd, packageInfo.config.name);

  if (!(await exists(packageDir)) || !(await isDirectory(packageDir))) {
    return [];
  }

  const [
    localPlatformCandidates,
    workspacePlatformCandidates,
    localRootCandidates,
    workspaceRootCandidates
  ] = await Promise.all([
    loadLocalCandidates(packageDir),
    discoverWorkspaceCandidates(cwd, packageInfo.config.name),
    loadLocalRootSaveCandidates(packageDir, packageInfo.config.name),
    discoverWorkspaceRootSaveCandidates(cwd, packageInfo.config.name)
  ]);

  const localCandidates = [...localPlatformCandidates, ...localRootCandidates];

  const indexRecord = await readPackageIndex(cwd, packageInfo.config.name);

  if (!indexRecord || Object.keys(indexRecord.files ?? {}).length === 0) {
    // No index yet (first save) – run root-only conflict resolution so prompts are shown for CLAUDE.md, WARP.md, etc.
    const rootGroups = buildCandidateGroups(localRootCandidates, workspaceRootCandidates);

    // Prune platform-specific root candidates that already exist locally (e.g., CLAUDE.md present)
    await pruneWorkspaceCandidatesWithLocalPlatformVariants(packageDir, rootGroups);

    for (const group of rootGroups) {
      const hasLocal = !!group.local;
      const hasWorkspace = group.workspace.length > 0;

      // A "differing" workspace set means either:
      // - there is no local file yet (creation case), or
      // - at least one workspace candidate differs from local
      const hasDifferingWorkspace =
        hasWorkspace &&
        (!hasLocal || group.workspace.some(w => w.contentHash !== group.local?.contentHash));

      // If there are no workspace candidates, or all workspace candidates are identical
      // to the local one, there's nothing to do.
      if (!hasWorkspace || !hasDifferingWorkspace) {
        continue;
      }

      const resolution = await resolveRootGroup(group, options.force ?? false);
      if (!resolution) continue;

      const { selection, platformSpecific } = resolution;

      // Always write universal AGENTS.md from the selected root section
      await writeRootSelection(packageDir, packageInfo.config.name, group.local, selection);

      // Persist platform-specific root selections (e.g., CLAUDE.md, WARP.md)
      for (const candidate of platformSpecific) {
        const platform = candidate.platform;
        if (!platform || platform === 'ai') continue;

        const platformRegistryPath = createPlatformSpecificRegistryPath(group.registryPath, platform);
        if (!platformRegistryPath) continue;

        const targetPath = join(packageDir, platformRegistryPath);
        try {
          await ensureDir(dirname(targetPath));

          const contentToWrite = candidate.isRootFile
            ? (candidate.sectionBody ?? candidate.content).trim()
            : candidate.content;

          if (await exists(targetPath)) {
            const existingContent = await readTextFile(targetPath, UTF8_ENCODING);
            if (existingContent === contentToWrite) {
              continue;
            }
          }

          await writeTextFile(targetPath, contentToWrite, UTF8_ENCODING);
          logger.debug(`Wrote platform-specific file: ${platformRegistryPath}`);
        } catch (error) {
          logger.warn(`Failed to write platform-specific file ${platformRegistryPath}: ${error}`);
        }
      }
    }

    // After resolving root conflicts, return filtered files from local dir
    return await readFilteredLocalPackageFiles(packageDir);
  }

  const fileKeys = new Set<string>();
  const dirKeys: string[] = [];

  for (const rawKey of Object.keys(indexRecord.files)) {
    if (isDirKey(rawKey)) {
      const trimmed = rawKey.endsWith('/') ? rawKey.slice(0, -1) : rawKey;
      if (!trimmed) {
        continue;
      }
      const normalized = normalizeRegistryPath(trimmed);
      dirKeys.push(`${normalized}/`);
    } else {
      fileKeys.add(normalizeRegistryPath(rawKey));
    }
  }

  const isAllowedRegistryPathForPackage = (registryPath: string): boolean => {
    const normalizedPath = normalizeRegistryPath(registryPath);
    if (fileKeys.has(normalizedPath)) {
      return true;
    }
    return dirKeys.some(dirKey => normalizedPath.startsWith(dirKey));
  };

  const filteredWorkspacePlatformCandidates = workspacePlatformCandidates.filter(candidate =>
    isAllowedRegistryPathForPackage(candidate.registryPath)
  );

  const filteredWorkspaceRootCandidates = workspaceRootCandidates.filter(candidate =>
    candidate.isRootFile || isAllowedRegistryPathForPackage(candidate.registryPath)
  );

  const workspaceCandidates = [...filteredWorkspacePlatformCandidates, ...filteredWorkspaceRootCandidates];

  const groups = buildCandidateGroups(localCandidates, workspaceCandidates);
  const frontmatterPlans = buildFrontmatterMergePlans(groups);

  // Prune platform-specific workspace candidates that already have local platform-specific files
  await pruneWorkspaceCandidatesWithLocalPlatformVariants(packageDir, groups);

  // Resolve conflicts and write chosen content back to local files
  for (const group of groups) {
    const hasLocal = !!group.local;
    const hasWorkspace = group.workspace.length > 0;

    const hasDifferingWorkspace =
      hasWorkspace &&
      (!hasLocal || group.workspace.some(w => w.contentHash !== group.local?.contentHash));

    // If there are no workspace candidates, or all workspace candidates are identical
    // to the local one, skip.
    if (!hasWorkspace || !hasDifferingWorkspace) {
      continue;
    }

    const isRootConflict =
      group.registryPath === FILE_PATTERNS.AGENTS_MD &&
      ((group.local && group.local.isRootFile) || group.workspace.some(w => w.isRootFile));

    const resolution = isRootConflict
      ? await resolveRootGroup(group, options.force ?? false)
      : await resolveGroup(group, options.force ?? false);
    if (!resolution) continue;

    const { selection, platformSpecific } = resolution;

    if (group.registryPath === FILE_PATTERNS.AGENTS_MD && selection.isRootFile) {
      await writeRootSelection(packageDir, packageInfo.config.name, group.local, selection);
      // Continue to platform-specific persistence below (don't skip it)
    } else {
      if (group.local && selection.contentHash !== group.local.contentHash) {
        // Overwrite local file content with selected content
        const targetPath = join(packageDir, group.registryPath);
        try {
          await writeTextFile(targetPath, selection.content, UTF8_ENCODING);
          logger.debug(`Updated local file with selected content: ${group.registryPath}`);
        } catch (error) {
          logger.warn(`Failed to write selected content to ${group.registryPath}: ${error}`);
        }
      } else if (!group.local) {
        // No local file existed; write the selected content to create it
        const targetPath = join(packageDir, group.registryPath);
        try {
          await ensureDir(dirname(targetPath));
          await writeTextFile(targetPath, selection.content, UTF8_ENCODING);
          logger.debug(`Created local file with selected content: ${group.registryPath}`);
        } catch (error) {
          logger.warn(`Failed to create selected content for ${group.registryPath}: ${error}`);
        }
      }
    }

    // Persist platform-specific selections chosen during conflict resolution
    // For root files, this writes platform-specific root files (e.g., CLAUDE.md, WARP.md)
    for (const candidate of platformSpecific) {
      const platform = candidate.platform;
      if (!platform || platform === 'ai') {
        continue;
      }

      const platformRegistryPath = createPlatformSpecificRegistryPath(group.registryPath, platform);
      if (!platformRegistryPath) {
        continue;
      }

      const targetPath = join(packageDir, platformRegistryPath);

      try {
        await ensureDir(dirname(targetPath));

        // For root files, use sectionBody (extracted package content) instead of full content
        const contentToWrite = candidate.isRootFile
          ? (candidate.sectionBody ?? candidate.content).trim()
          : candidate.content;

        if (await exists(targetPath)) {
          const existingContent = await readTextFile(targetPath, UTF8_ENCODING);
          if (existingContent === contentToWrite) {
            continue;
          }
        }

        await writeTextFile(targetPath, contentToWrite, UTF8_ENCODING);
        logger.debug(`Wrote platform-specific file: ${platformRegistryPath}`);
      } catch (error) {
        logger.warn(`Failed to write platform-specific file ${platformRegistryPath}: ${error}`);
      }
    }
  }

  // After resolving conflicts by updating local files, simply read filtered files from local dir
  await applyFrontmatterMergePlans(packageDir, frontmatterPlans);
  return await readFilteredLocalPackageFiles(packageDir);
}

async function writeRootSelection(
  packageDir: string,
  packageName: string,
  localCandidate: SaveCandidate | undefined,
  selection: SaveCandidate
): Promise<void> {
  const targetPath = `${packageDir}/${FILE_PATTERNS.AGENTS_MD}`;
  const sectionBody = (selection.sectionBody ?? selection.content).trim();
  const finalContent = sectionBody;

  try {
    if (await exists(targetPath)) {
      const existingContent = await readTextFile(targetPath, UTF8_ENCODING);
      if (existingContent === finalContent) {
        logger.debug(`Root file unchanged: ${FILE_PATTERNS.AGENTS_MD}`);
        return;
      }
    }

    await writeTextFile(targetPath, finalContent, UTF8_ENCODING);
    logger.debug(`Updated root file content for ${packageName}`);
  } catch (error) {
    logger.warn(`Failed to write root file ${FILE_PATTERNS.AGENTS_MD}: ${error}`);
  }
}

/**
 * Check if a path is a YAML override file that should be included despite isAllowedRegistryPath filtering.
 * YAML override files are files like "rules/agent.claude.yml" that contain platform-specific frontmatter.
 */
function isYamlOverrideFileForSave(normalizedPath: string): boolean {
  // Must be skippable (which includes YAML override check) but not package.yml
  return normalizedPath !== FILE_PATTERNS.PACKAGE_YML && isSkippableRegistryPath(normalizedPath);
}

async function readFilteredLocalPackageFiles(packageDir: string): Promise<PackageFile[]> {
  const entries = await findFilesByExtension(packageDir, [], packageDir);
  const files: PackageFile[] = [];

  for (const entry of entries) {
    const normalizedPath = normalizeRegistryPath(entry.relativePath);
    if (normalizedPath === PACKAGE_INDEX_FILENAME) continue;

    // Allow files that are either allowed by normal rules, root files, YAML override files,
    // or any root-level files adjacent to package.yml (including package.yml itself)
    const isAllowed = isAllowedRegistryPath(normalizedPath);
    const isRoot = isRootRegistryPath(normalizedPath);
    const isYamlOverride = isYamlOverrideFileForSave(normalizedPath);
    const isPackageYml = normalizedPath === FILE_PATTERNS.PACKAGE_YML;
    const isRootLevelFile = !normalizedPath.includes('/');

    if (!isAllowed && !isRoot && !isYamlOverride && !isPackageYml && !isRootLevelFile) continue;

    const content = await readTextFile(entry.fullPath);
    files.push({
      path: normalizedPath,
      content,
      encoding: UTF8_ENCODING
    });
  }

  return files;
}



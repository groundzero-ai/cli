import { dirname, join } from 'path';
import type { PackageFile } from '../../types/index.js';
import type { PackageContext } from '../package-context.js';
import { FILE_PATTERNS } from '../../constants/index.js';
import { readPackageIndex, isDirKey } from '../../utils/package-index-yml.js';
import { ensureDir, exists, isDirectory, readTextFile, writeTextFile, remove } from '../../utils/fs.js';
import {
  normalizeRegistryPath,
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
  getOverrideRelativePath,
} from './save-yml-resolution.js';
import { loadLocalCandidates, discoverWorkspaceCandidates } from './save-candidate-loader.js';
import {
  buildCandidateGroups,
  pruneWorkspaceCandidatesWithLocalPlatformVariants,
  resolveGroup,
  resolveRootGroup
} from './save-conflict-resolver.js';
import { readPackageFilesForRegistry } from '../../utils/package-copy.js';
import { composeMarkdown } from '../../utils/markdown-frontmatter.js';

export interface SaveConflictResolutionOptions {
  force?: boolean;
}

export async function resolvePackageFilesWithConflicts(
  packageContext: PackageContext,
  options: SaveConflictResolutionOptions = {}
): Promise<PackageFile[]> {
  const cwd = process.cwd();
  const packageFilesDir = packageContext.packageFilesDir;
  const packageRootDir = packageContext.packageRootDir;

  if (!(await exists(packageFilesDir)) || !(await isDirectory(packageFilesDir))) {
    return [];
  }

  const [
    localPlatformCandidates,
    workspacePlatformCandidates,
    localRootCandidates,
    workspaceRootCandidates
  ] = await Promise.all([
    loadLocalCandidates(packageRootDir),
    discoverWorkspaceCandidates(cwd, packageContext.config.name),
    loadLocalRootSaveCandidates(packageRootDir, packageContext.config.name),
    discoverWorkspaceRootSaveCandidates(cwd, packageContext.config.name)
  ]);

  const localCandidates = [...localPlatformCandidates, ...localRootCandidates];

  const indexRecord = await readPackageIndex(cwd, packageContext.config.name, packageContext.location);

  if (!indexRecord || Object.keys(indexRecord.files ?? {}).length === 0) {
    // No index yet (first save) – run root-only conflict resolution so prompts are shown for CLAUDE.md, WARP.md, etc.
    const rootGroups = buildCandidateGroups(localRootCandidates, workspaceRootCandidates);

    // Prune platform-specific root candidates that already exist locally (e.g., CLAUDE.md present)
    await pruneWorkspaceCandidatesWithLocalPlatformVariants(packageRootDir, rootGroups);

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
      await writeRootSelection(packageRootDir, packageContext.config.name, group.local, selection);

      // Persist platform-specific root selections (e.g., CLAUDE.md, WARP.md)
      for (const candidate of platformSpecific) {
        const platform = candidate.platform;
        if (!platform || platform === 'ai') continue;

        const platformRegistryPath = createPlatformSpecificRegistryPath(group.registryPath, platform);
        if (!platformRegistryPath) continue;

        const targetPath = join(packageRootDir, platformRegistryPath);
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
    return await readPackageFilesForRegistry(packageRootDir);
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
  let frontmatterPlans = await buildFrontmatterMergePlans(packageRootDir, groups);
  const frontmatterPlanMap = new Map(frontmatterPlans.map(plan => [plan.registryPath, plan]));
  const pathsWithFrontmatterPlans = new Set(frontmatterPlanMap.keys());

  // Prune platform-specific workspace candidates that already have local platform-specific files
  await pruneWorkspaceCandidatesWithLocalPlatformVariants(packageRootDir, groups);

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
      await writeRootSelection(packageRootDir, packageContext.config.name, group.local, selection);
      // Continue to platform-specific persistence below (don't skip it)
    } else if (pathsWithFrontmatterPlans.has(group.registryPath)) {
      // Only update markdown body; frontmatter will be handled by merge plans
      if (group.local) {
        const localBody = group.local.markdownBody ?? group.local.content;
        const selectionBody = selection.markdownBody ?? selection.content;

        if ((selectionBody ?? '').trim() !== (localBody ?? '').trim()) {
          const targetPath = join(packageRootDir, group.registryPath);
          const localFrontmatter = group.local.frontmatter;
          const updatedContent = composeMarkdown(localFrontmatter, selectionBody);

          try {
            await writeTextFile(targetPath, updatedContent, UTF8_ENCODING);
            logger.debug(
              `Updated markdown body (frontmatter deferred to merge plan): ${group.registryPath}`
            );
          } catch (error) {
            logger.warn(`Failed to update markdown body for ${group.registryPath}: ${error}`);
          }
        }
      }
    } else {
      if (group.local && selection.contentHash !== group.local.contentHash) {
        // Overwrite local file content with selected content
        const targetPath = join(packageRootDir, group.registryPath);
        try {
          await writeTextFile(targetPath, selection.content, UTF8_ENCODING);
          logger.debug(`Updated local file with selected content: ${group.registryPath}`);
        } catch (error) {
          logger.warn(`Failed to write selected content to ${group.registryPath}: ${error}`);
        }
      } else if (!group.local) {
        // No local file existed; write the selected content to create it
        const targetPath = join(packageRootDir, group.registryPath);
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

      const targetPath = join(packageRootDir, platformRegistryPath);

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

        if (pathsWithFrontmatterPlans.has(group.registryPath)) {
          const overrideRelativePath = getOverrideRelativePath(group.registryPath, platform);
          if (overrideRelativePath) {
          const overrideFullPath = join(packageRootDir, overrideRelativePath);
            if (await exists(overrideFullPath)) {
              await remove(overrideFullPath);
              logger.debug(`Removed redundant platform override: ${overrideRelativePath}`);
            }
          }

          const plan = frontmatterPlanMap.get(group.registryPath);
          if (plan) {
            plan.workspaceEntries = plan.workspaceEntries.filter(entry => entry.platform !== platform);
            plan.platformOverrides.delete(platform);
            if (plan.workspaceEntries.length === 0) {
              frontmatterPlanMap.delete(group.registryPath);
              pathsWithFrontmatterPlans.delete(group.registryPath);
            }
          }
        }
      } catch (error) {
        logger.warn(`Failed to write platform-specific file ${platformRegistryPath}: ${error}`);
      }
    }
  }

  // After resolving conflicts by updating local files, simply read filtered files from local dir
  frontmatterPlans = frontmatterPlans.filter(plan => plan.workspaceEntries.length > 0);
  await applyFrontmatterMergePlans(packageRootDir, frontmatterPlans);
  return await readPackageFilesForRegistry(packageRootDir);
}

async function writeRootSelection(
  packageRootDir: string,
  packageName: string,
  localCandidate: SaveCandidate | undefined,
  selection: SaveCandidate
): Promise<void> {
  const targetPath = join(packageRootDir, FILE_PATTERNS.AGENTS_MD);
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



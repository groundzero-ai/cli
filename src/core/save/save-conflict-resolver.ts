import { join } from 'path';

import { exists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { safePrompts, promptPlatformSpecificSelection, getContentPreview } from '../../utils/prompts.js';
import { createPlatformSpecificRegistryPath } from '../../utils/platform-specific-paths.js';
import { SaveCandidate } from './save-types.js';
import type { SaveConflictResolution } from './save-types.js';
import type { SaveCandidateGroup } from './save-yml-resolution.js';

export function buildCandidateGroups(
  localCandidates: SaveCandidate[],
  workspaceCandidates: SaveCandidate[]
): SaveCandidateGroup[] {
  const map = new Map<string, SaveCandidateGroup>();

  for (const candidate of localCandidates) {
    const group = ensureGroup(map, candidate.registryPath);
    group.local = candidate;
  }

  for (const candidate of workspaceCandidates) {
    const group = ensureGroup(map, candidate.registryPath);
    group.workspace.push(candidate);
  }

  return Array.from(map.values());
}

export async function pruneWorkspaceCandidatesWithLocalPlatformVariants(
  packageDir: string,
  groups: SaveCandidateGroup[]
): Promise<void> {
  for (const group of groups) {
    if (!group.local) {
      continue;
    }

    const filtered: SaveCandidate[] = [];
    for (const candidate of group.workspace) {
      const platform = candidate.platform;
      if (!platform || platform === 'ai') {
        filtered.push(candidate);
        continue;
      }

      const platformRegistryPath = createPlatformSpecificRegistryPath(group.registryPath, platform);
      if (!platformRegistryPath) {
        filtered.push(candidate);
        continue;
      }

      const platformFullPath = join(packageDir, platformRegistryPath);
      if (await exists(platformFullPath)) {
        logger.debug(
          `Skipping workspace candidate ${candidate.displayPath} for ${group.registryPath} ` +
            `because local platform-specific file ${platformRegistryPath} already exists`
        );
        continue;
      }

      filtered.push(candidate);
    }

    group.workspace = filtered;
  }
}

export async function resolveRootGroup(
  group: SaveCandidateGroup,
  force: boolean
): Promise<SaveConflictResolution | undefined> {
  const orderedCandidates: SaveCandidate[] = [];

  if (group.local) {
    orderedCandidates.push(group.local);
  }

  if (group.workspace.length > 0) {
    const sortedWorkspace = [...group.workspace].sort((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.displayPath.localeCompare(b.displayPath);
    });
    orderedCandidates.push(...sortedWorkspace);
  }

  if (orderedCandidates.length === 0) {
    return undefined;
  }

  const uniqueCandidates = dedupeByHash(orderedCandidates);

  if (uniqueCandidates.length === 1) {
    return {
      selection: uniqueCandidates[0],
      platformSpecific: []
    };
  }

  if (group.local) {
    const localCandidate = group.local;
    const differsFromAnyWorkspace = group.workspace.some(w => w.contentHash !== localCandidate.contentHash);

    if (differsFromAnyWorkspace) {
      const latestWorkspaceMtime =
        group.workspace.length > 0 ? Math.max(...group.workspace.map(w => w.mtime)) : 0;

      if (localCandidate.mtime >= latestWorkspaceMtime) {
        return {
          selection: localCandidate,
          platformSpecific: []
        };
      }

      if (force) {
        logger.info(`Force-selected local version for ${group.registryPath}`);
        return {
          selection: localCandidate,
          platformSpecific: []
        };
      }

      return await promptForCandidate(group.registryPath, uniqueCandidates);
    }
  }

  if (force) {
    const selected = pickLatestByMtime(uniqueCandidates);
    logger.info(`Force-selected ${selected.displayPath} for ${group.registryPath}`);
    return {
      selection: selected,
      platformSpecific: []
    };
  }

  return await promptForCandidate(group.registryPath, uniqueCandidates);
}

export async function resolveGroup(
  group: SaveCandidateGroup,
  force: boolean
): Promise<SaveConflictResolution | undefined> {
  const orderedCandidates: SaveCandidate[] = [];

  if (group.local) {
    orderedCandidates.push(group.local);
  }

  if (group.workspace.length > 0) {
    const sortedWorkspace = [...group.workspace].sort((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.displayPath.localeCompare(b.displayPath);
    });
    orderedCandidates.push(...sortedWorkspace);
  }

  if (orderedCandidates.length === 0) {
    return undefined;
  }

  const uniqueCandidates = dedupeByHash(orderedCandidates);

  if (uniqueCandidates.length === 1) {
    return {
      selection: uniqueCandidates[0],
      platformSpecific: []
    };
  }

  if (group.local) {
    const localCandidate = group.local;
    const differsFromAnyWorkspace = group.workspace.some(w => w.contentHash !== localCandidate.contentHash);

    if (differsFromAnyWorkspace) {
      const latestWorkspaceMtime =
        group.workspace.length > 0
          ? Math.max(...group.workspace.map(w => w.mtime))
          : 0;

      if (localCandidate.mtime >= latestWorkspaceMtime) {
        return {
          selection: localCandidate,
          platformSpecific: []
        };
      }

      if (!force) {
        return await promptForCandidate(group.registryPath, uniqueCandidates);
      }

      logger.info(`Force-selected local version for ${group.registryPath}`);
      return {
        selection: localCandidate,
        platformSpecific: []
      };
    }
  }

  if (force) {
    const selected = pickLatestByMtime(uniqueCandidates);
    logger.info(`Force-selected ${selected.displayPath} for ${group.registryPath}`);
    return {
      selection: selected,
      platformSpecific: []
    };
  }

  return await promptForCandidate(group.registryPath, uniqueCandidates);
}

function ensureGroup(map: Map<string, SaveCandidateGroup>, registryPath: string): SaveCandidateGroup {
  let group = map.get(registryPath);
  if (!group) {
    group = {
      registryPath,
      workspace: []
    };
    map.set(registryPath, group);
  }
  return group;
}

function dedupeByHash(candidates: SaveCandidate[]): SaveCandidate[] {
  const seen = new Set<string>();
  const unique: SaveCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.contentHash)) {
      continue;
    }
    seen.add(candidate.contentHash);
    unique.push(candidate);
  }

  return unique;
}

function pickLatestByMtime(candidates: SaveCandidate[]): SaveCandidate {
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i += 1) {
    const current = candidates[i];
    if (current.mtime > best.mtime) {
      best = current;
    }
  }
  return best;
}

async function promptForCandidate(
  registryPath: string,
  candidates: SaveCandidate[]
): Promise<SaveConflictResolution> {
  console.log(`\n⚠️  Conflict detected for ${registryPath}:`);
  candidates.forEach(candidate => {
    console.log(`  • ${formatCandidateLabel(candidate)}`);
  });

  const platformEligibleWorkspace = candidates.filter(
    candidate => candidate.source === 'workspace' && candidate.platform && candidate.platform !== 'ai'
  );
  let markedPlatformSpecific: SaveCandidate[] = [];

  if (platformEligibleWorkspace.length > 0) {
    const options = await Promise.all(
      platformEligibleWorkspace.map(async candidate => ({
        platform: candidate.platform ?? 'workspace',
        sourcePath: candidate.fullPath,
        preview: await getContentPreview(candidate.fullPath),
        registryPath: candidate.displayPath
      }))
    );

    const indices = await promptPlatformSpecificSelection(
      options,
      'Select workspace files to mark as platform-specific:',
      'Unselected files remain candidates for universal content'
    );

    const markedIndexSet = new Set<number>(indices);
    markedPlatformSpecific = platformEligibleWorkspace.filter((_, idx) => markedIndexSet.has(idx));
  }

  const markedSet = new Set(markedPlatformSpecific);

  const local = candidates.find(candidate => candidate.source === 'local');
  const remainingWorkspace = candidates.filter(
    candidate => candidate.source === 'workspace' && !markedSet.has(candidate)
  );
  const universalChoices: SaveCandidate[] = [...(local ? [local] : []), ...remainingWorkspace];

  const resolvePlatformSpecific = (selection: SaveCandidate): SaveCandidate[] => {
    if (!markedSet.has(selection)) {
      return markedPlatformSpecific;
    }
    return markedPlatformSpecific.filter(candidate => candidate !== selection);
  };

  if (universalChoices.length === 0) {
    const fallbackSelection = candidates[0];
    return {
      selection: fallbackSelection,
      platformSpecific: resolvePlatformSpecific(fallbackSelection)
    };
  }

  if (universalChoices.length === 1) {
    const selection = universalChoices[0];
    return {
      selection,
      platformSpecific: resolvePlatformSpecific(selection)
    };
  }

  const response = await safePrompts({
    type: 'select',
    name: 'selectedIndex',
    message: `Choose universal content to save for ${registryPath}:`,
    choices: universalChoices.map((candidate, index) => ({
      title: formatCandidateLabel(candidate),
      value: index
    })),
    hint: 'Use arrow keys to compare options and press Enter to select'
  });

  const selectedIndex = (response as any).selectedIndex as number;
  const selection = universalChoices[selectedIndex];
  return {
    selection,
    platformSpecific: resolvePlatformSpecific(selection)
  };
}

function formatCandidateLabel(candidate: SaveCandidate): string {
  const prefix = candidate.source === 'local' ? 'Package' : 'Workspace';
  return `${prefix}: ${candidate.displayPath}`;
}



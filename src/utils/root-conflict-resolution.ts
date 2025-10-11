/**
 * Root Conflict Resolution Module
 * Utility functions for resolving root file conflicts during formula saving
 */

import { isLocalVersion } from '../utils/version-generator.js';
import { safePrompts } from './prompts.js';
import type { DiscoveredFile } from '../types/index.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { getPlatformDefinition } from '../core/platforms.js';

// Constants for conflict resolution
const KEEP_ALL_ROOT_FILES_SEPARATE = -1;

/**
 * Helper to get original root file name from platform
 * Maps platform back to its native root file name
 */
function createRootFilePath(platformName: string): string {
  try {
    const def = getPlatformDefinition(platformName as any);
    if (def && def.rootFile) {
      return def.rootFile;
    }
  } catch (error) {
    // Platform not found or no root file defined
  }
  // Fallback to AGENTS.md if platform doesn't have a specific root file
  return FILE_PATTERNS.AGENTS_MD;
}

/**
 * Analyze root file conflicts using mtime/content-hash logic
 * Returns whether files can be resolved to a single universal file
 */
function analyzeRootFileConflicts(files: DiscoveredFile[]): {
  canResolveToUniversal: boolean;
  universalFile?: DiscoveredFile;
} {
  if (files.length === 0) {
    return { canResolveToUniversal: false };
  }

  if (files.length === 1) {
    return { canResolveToUniversal: true, universalFile: files[0] };
  }

  // Group files by content hash
  const contentGroups = new Map<string, DiscoveredFile[]>();
  for (const file of files) {
    if (!contentGroups.has(file.contentHash)) {
      contentGroups.set(file.contentHash, []);
    }
    contentGroups.get(file.contentHash)!.push(file);
  }

  // If all files have the same content, pick latest by mtime
  if (contentGroups.size === 1) {
    const latestFile = findLatestFile(files);
    return { canResolveToUniversal: true, universalFile: latestFile };
  }

  // Check if all files have different mtime
  const mtimes = files.map(f => f.mtime);
  const uniqueMtimes = Array.from(new Set(mtimes));
  
  if (uniqueMtimes.length === files.length) {
    // All different mtimes - pick latest
    const latestFile = findLatestFile(files);
    return { canResolveToUniversal: true, universalFile: latestFile };
  }

  // Cannot resolve automatically - different content with overlapping mtimes
  return { canResolveToUniversal: false };
}

/**
 * Handle interactive root file selection for stable versions
 * Allows user to pick which root file becomes universal AGENTS.md
 * or keep all files separate with their original names
 */
async function handleInteractiveRootFileSelection(files: DiscoveredFile[]): Promise<DiscoveredFile[]> {
  console.log(`\n📄 Multiple root files detected (${files.length} files):`);
  for (const file of files) {
    console.log(`   - ${file.relativePath} (from ${file.sourceDir})`);
  }

  const choices = files.map((file, index) => ({
    title: `${file.relativePath} (${file.sourceDir}) → becomes universal AGENTS.md`,
    value: index
  }));

  // Add option to keep all files separate
  choices.push({
    title: 'Keep all root files separate with their original names',
    value: KEEP_ALL_ROOT_FILES_SEPARATE
  });

  const response = await safePrompts({
    type: 'select',
    name: 'selectedValue',
    message: 'Select root file resolution strategy:',
    choices,
    hint: 'Universal AGENTS.md is preferred for cross-platform compatibility'
  });

  if (response.selectedValue === KEEP_ALL_ROOT_FILES_SEPARATE) {
    // Keep all files with their original names
    return files.map(file => ({
      ...file,
      registryPath: createRootFilePath(file.sourceDir)
    }));
  } else {
    // User selected a file to become universal AGENTS.md
    const universalFile = files[response.selectedValue];
    return [{
      ...universalFile,
      registryPath: FILE_PATTERNS.AGENTS_MD
    }];
  }
}

/**
 * Find the latest file in a group based on modification time
 */
function findLatestFile(files: DiscoveredFile[]): DiscoveredFile {
  return files.reduce((latest, current) =>
    current.mtime > latest.mtime ? current : latest
  );
}

/**
 * Resolve root file conflicts separately from normal file conflicts
 * Root files maintain their original names (AGENTS.md, CLAUDE.md, etc.)
 * or resolve to universal AGENTS.md based on content analysis
 */
export async function resolveRootFileConflicts(
  rootFiles: DiscoveredFile[],
  targetVersion?: string,
  silent?: boolean
): Promise<DiscoveredFile[]> {
  if (rootFiles.length === 0) {
    return [];
  }

  if (rootFiles.length === 1) {
    // Single root file - use AGENTS.md as universal name
    return [{
      ...rootFiles[0],
      registryPath: FILE_PATTERNS.AGENTS_MD
    }];
  }

  // Multiple root files - analyze conflicts
  const analysis = analyzeRootFileConflicts(rootFiles);
  const isStableVersion = targetVersion ? !isLocalVersion(targetVersion) : false;

  if (analysis.canResolveToUniversal && analysis.universalFile) {
    // Can resolve to universal AGENTS.md
    if (!silent) {
      console.log(`✓ Resolved ${rootFiles.length} root files to universal AGENTS.md`);
    }
    return [{
      ...analysis.universalFile,
      registryPath: FILE_PATTERNS.AGENTS_MD
    }];
  }

  // Cannot resolve automatically
  if (isStableVersion) {
    // Stable version - prompt user
    if (!silent) {
      console.log(`⚠️  Cannot auto-resolve root file conflicts for stable version`);
    }
    return await handleInteractiveRootFileSelection(rootFiles);
  } else {
    // Prerelease version - save all files with original names
    if (!silent) {
      console.log(`✓ Saving ${rootFiles.length} root files with original names (prerelease)`);
    }
    return rootFiles.map(file => ({
      ...file,
      registryPath: createRootFilePath(file.sourceDir)
    }));
  }
}

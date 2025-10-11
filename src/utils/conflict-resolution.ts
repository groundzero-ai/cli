/**
 * Conflict Resolution Module
 * Utility functions for resolving file conflicts during formula saving
 */

import { join, basename, dirname } from 'path';
import { getPlatformNameFromSource } from './platform-utils.js';
import { isLocalVersion } from '../utils/version-generator.js';
import { promptPlatformSpecificSelection, getContentPreview, safePrompts } from './prompts.js';
import { updateMarkdownWithFormulaFrontmatter } from './md-frontmatter.js';
import { readTextFile, writeTextFile } from './fs.js';
import type { DiscoveredFile, ContentAnalysisResult } from '../types/index.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { getPlatformDefinition } from '../core/platforms.js';

// Constants for conflict resolution
const MARK_ALL_AS_PLATFORM_SPECIFIC = -1;

// File option interface for user selection
interface FileSelectionOption {
  platform: string;
  sourcePath: string;
  preview: string;
  registryPath: string;
}

/**
 * Enhanced conflict resolution using content-based analysis
 * Includes interactive universal file selection for stable versions
 */
export async function resolveFileConflicts(
  discoveredFiles: DiscoveredFile[],
  targetVersion?: string,
  silent?: boolean
): Promise<DiscoveredFile[]> {
  // Group files by their target registry path
  const fileGroups = new Map<string, DiscoveredFile[]>();

  for (const file of discoveredFiles) {
    if (!fileGroups.has(file.registryPath)) {
      fileGroups.set(file.registryPath, []);
    }
    fileGroups.get(file.registryPath)!.push(file);
  }

  const resolvedFiles: DiscoveredFile[] = [];

  // Process each group using enhanced content-based logic
  for (const [registryPath, files] of Array.from(fileGroups.entries())) {
    if (files.length === 1) {
      // No conflict, keep the file
      resolvedFiles.push(files[0]);
    } else {
      // Multiple files - use content-based conflict resolution
      const analysisResult = await analyzeContentConflicts(files, targetVersion);

      // Add universal files (no prefix)
      for (const universal of analysisResult.universalFiles) {
        resolvedFiles.push(universal.file);
      }

      // Add platform-specific files (with prefix)
      for (const platformSpecific of analysisResult.platformSpecificFiles) {
        // Update the file's registry path to include platform suffix
        const updatedFile = {
          ...platformSpecific.file,
          registryPath: platformSpecific.finalRegistryPath
        };
        resolvedFiles.push(updatedFile);
      }

      // Log resolution decisions (can be silenced)
      logConflictResolution(registryPath, files, analysisResult, silent);
    }
  }

  return resolvedFiles;
}

/**
 * Analyze content conflicts and determine resolution strategy
 * Includes interactive universal file selection for stable versions
 */
export async function analyzeContentConflicts(
  files: DiscoveredFile[],
  targetVersion?: string
): Promise<ContentAnalysisResult> {
  const result: ContentAnalysisResult = {
    universalFiles: [],
    platformSpecificFiles: []
  };

  // Check if this is a stable version (not prerelease)
  const isStableVersion = targetVersion ? !isLocalVersion(targetVersion) : false;

  // Separate platform-specific files from normal files
  const platformSpecificFiles = files.filter(f => f.forcePlatformSpecific);
  const normalFiles = files.filter(f => !f.forcePlatformSpecific);

  // Handle platform-specific files - each gets platform prefix
  for (const file of platformSpecificFiles) {
    const platformName = getPlatformNameFromSource(file.sourceDir);
    const originalBase = basename(file.registryPath, FILE_PATTERNS.MD_FILES);
    const platformSpecificPath = join(dirname(file.registryPath) || '', `${originalBase}.${platformName}${FILE_PATTERNS.MD_FILES}`);

    result.platformSpecificFiles.push({
      file,
      platformName,
      finalRegistryPath: platformSpecificPath
    });
  }

  // Handle normal files
  if (normalFiles.length > 0) {
    const normalResult = await analyzeNormalConflicts(normalFiles, isStableVersion);
    result.universalFiles.push(...normalResult.universalFiles);
    result.platformSpecificFiles.push(...normalResult.platformSpecificFiles);
  }

  return result;
}

/**
 * Analyze conflicts for normal (non-platform-specific) files
 * Includes interactive universal file selection for stable versions
 */
async function analyzeNormalConflicts(
  files: DiscoveredFile[],
  isStableVersion: boolean
): Promise<ContentAnalysisResult> {
  const result: ContentAnalysisResult = {
    universalFiles: [],
    platformSpecificFiles: []
  };

  // Check for the problematic scenario: same mtime, different content, multiple files
  const hasProblematicScenario = files.length > 1 &&
                                files.every(f => f.mtime === files[0].mtime) && // All same mtime
                                new Set(files.map(f => f.contentHash)).size === files.length; // All different hashes

  // If this is a stable version AND we have the problematic scenario, use interactive selection
  if (isStableVersion && hasProblematicScenario) {
    return await handleInteractiveUniversalSelection(files);
  }

  // Otherwise, use the existing algorithm
  return analyzeNormalConflictsStandard(files);
}

/**
 * Handle interactive universal file selection for stable versions
 */
async function handleInteractiveUniversalSelection(files: DiscoveredFile[]): Promise<ContentAnalysisResult> {
  const result: ContentAnalysisResult = {
    universalFiles: [],
    platformSpecificFiles: []
  };

  try {
    // Step 1: Prepare file options (without previews for universal selection)
    const fileOptions = await prepareFileOptions(files);

    // Step 2: Universal file selection OR mark all as platform-specific
    const selectionResult = await handleUniversalFileSelectionWithMarkAll(files, fileOptions);

    if (selectionResult.markAllAsPlatformSpecific) {
      // Mark all files as platform-specific
      const allPlatformSpecific = await markAllFilesAsPlatformSpecific(files);
      result.platformSpecificFiles.push(...allPlatformSpecific);
    } else {
      // Step 3: Mark additional platform-specific files (excluding universal)
      const { platformSpecificFiles, remainingFiles } = await handlePlatformSpecificMarking(
        files,
        fileOptions,
        selectionResult.universalIndex
      );

      // Add platform-specific files to result
      result.platformSpecificFiles.push(...platformSpecificFiles);

      // Step 4: Set universal file and synchronize unmarked files
      const universalFile = files[selectionResult.universalIndex!];
      result.universalFiles.push({
        file: universalFile,
        finalRegistryPath: universalFile.registryPath
      });

      // Synchronize unmarked files with universal file content
      if (remainingFiles.length > 0) {
        await syncFilesWithUniversalContent(universalFile, remainingFiles);
      }
    }

    console.log('✓ Interactive universal file selection completed');

  } catch (error) {
    if (error instanceof Error && error.message.includes('cancelled')) {
      console.log('⚠️  User cancelled interactive selection, falling back to standard algorithm');
      return analyzeNormalConflictsStandard(files);
    } else {
      console.error('❌ Error during interactive selection:', error);
      return analyzeNormalConflictsStandard(files);
    }
  }

  return result;
}

/**
 * Prepare file options with platform info and content previews
 */
async function prepareFileOptions(files: DiscoveredFile[]) {
  return await Promise.all(files.map(async (file, index) => ({
    platform: getPlatformNameFromSource(file.sourceDir),
    sourcePath: file.fullPath,
    preview: await getContentPreview(file.fullPath),
    registryPath: file.registryPath
  })));
}

/**
 * Handle universal file selection with option to mark all as platform-specific
 */
async function handleUniversalFileSelectionWithMarkAll(
  files: DiscoveredFile[],
  fileOptions: FileSelectionOption[]
): Promise<{ markAllAsPlatformSpecific: boolean; universalIndex?: number }> {
  const choices = files.map((file, index) => ({
    title: `${fileOptions[index].platform}: ${fileOptions[index].registryPath}`,
    value: index
  }));

  // Add the "mark all as platform-specific" option
  choices.push({
    title: 'Mark all as platform-specific',
    value: MARK_ALL_AS_PLATFORM_SPECIFIC // Special value to indicate mark all
  });

  const response = await safePrompts({
    type: 'select',
    name: 'selectedValue',
    message: 'Select universal file or mark all as platform-specific:',
    choices,
    hint: 'In the next step, you can select files to mark as platform-specific'
  });

  if (response.selectedValue === MARK_ALL_AS_PLATFORM_SPECIFIC) {
    return { markAllAsPlatformSpecific: true };
  } else {
    return { markAllAsPlatformSpecific: false, universalIndex: response.selectedValue };
  }
}

/**
 * Handle platform-specific file marking and return updated file sets
 */
async function handlePlatformSpecificMarking(
  files: DiscoveredFile[],
  fileOptions: FileSelectionOption[],
  excludeIndex?: number
): Promise<{
  platformSpecificFiles: Array<{
    file: DiscoveredFile;
    platformName: string;
    finalRegistryPath: string;
  }>,
  remainingFiles: DiscoveredFile[]
}> {
  const platformSpecificFiles: Array<{
    file: DiscoveredFile;
    platformName: string;
    finalRegistryPath: string;
  }> = [];

  // Filter out the excluded file (universal file) from options
  const filteredOptions = fileOptions.filter((_, index) => index !== excludeIndex);
  const filteredFiles = files.filter((_, index) => index !== excludeIndex);

  // Create options without content previews
  const platformSpecificOptions = filteredOptions.map((option, index) => ({
    platform: option.platform,
    sourcePath: option.sourcePath,
    preview: '', // Remove content previews
    registryPath: option.registryPath
  }));

  const platformSpecificIndices = await promptPlatformSpecificSelection(
    platformSpecificOptions,
    'Select files to mark as platform-specific (unmarked files will be overwritten with universal file content):',
    'Unmarked files will be overwritten and use the universal file'
  );

  // Mark selected files as platform-specific
  for (const index of platformSpecificIndices) {
    const file = filteredFiles[index];
    const content = await readTextFile(file.fullPath);
    const updatedContent = updateMarkdownWithFormulaFrontmatter(content, { platformSpecific: true });
    await writeTextFile(file.fullPath, updatedContent);

    // Update the file object to reflect the change
    file.forcePlatformSpecific = true;
    console.log(`✓ Marked ${file.registryPath} as platform-specific`);

    // Add to platform-specific results
    const platformName = getPlatformNameFromSource(file.sourceDir);
    const platformSpecificPath = createPlatformSpecificPath(file, platformName);
    if (platformSpecificPath) {
      platformSpecificFiles.push({
        file,
        platformName,
        finalRegistryPath: platformSpecificPath
      });
    }
  }

  // Get remaining files (not marked as platform-specific, including the excluded universal file)
  const markedIndices = new Set(platformSpecificIndices.map(idx => {
    // Find the original index in the full files array
    const file = filteredFiles[idx];
    return files.indexOf(file);
  }));

  const remainingFiles = files.filter((_, index) => !markedIndices.has(index) && index !== excludeIndex);

  return { platformSpecificFiles, remainingFiles };
}

/**
 * Mark all files as platform-specific
 */
async function markAllFilesAsPlatformSpecific(files: DiscoveredFile[]): Promise<Array<{
  file: DiscoveredFile;
  platformName: string;
  finalRegistryPath: string;
}>> {
  const platformSpecificFiles: Array<{
    file: DiscoveredFile;
    platformName: string;
    finalRegistryPath: string;
  }> = [];

  for (const file of files) {
    // Mark file as platform-specific in frontmatter
    const content = await readTextFile(file.fullPath);
    const updatedContent = updateMarkdownWithFormulaFrontmatter(content, { platformSpecific: true });
    await writeTextFile(file.fullPath, updatedContent);

    // Update the file object to reflect the change
    file.forcePlatformSpecific = true;
    console.log(`✓ Marked ${file.registryPath} as platform-specific`);

    // Add to platform-specific results
    const platformName = getPlatformNameFromSource(file.sourceDir);
    const originalBase = basename(file.registryPath, FILE_PATTERNS.MD_FILES);
    const platformSpecificPath = join(dirname(file.registryPath) || '', `${originalBase}.${platformName}${FILE_PATTERNS.MD_FILES}`);

    platformSpecificFiles.push({
      file,
      platformName,
      finalRegistryPath: platformSpecificPath
    });
  }

  return platformSpecificFiles;
}

/**
 * Synchronize files with universal content
 */
async function syncFilesWithUniversalContent(universalFile: DiscoveredFile, files: DiscoveredFile[]): Promise<void> {
  const universalContent = await readTextFile(universalFile.fullPath);
  for (const file of files) {
    if (file !== universalFile && !file.forcePlatformSpecific) {
      await writeTextFile(file.fullPath, universalContent);
      console.log(`✓ Updated ${file.registryPath} to match universal file`);
    }
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
 * Create platform-specific registry path for a file
 */
function createPlatformSpecificPath(file: DiscoveredFile, platformName: string): string | null {
  // Special handling for root-files group that target AGENTS.md: emit platform-native root filenames
  if (file.registryPath === FILE_PATTERNS.AGENTS_MD && dirname(file.registryPath) === '') {
    const def = getPlatformDefinition(platformName as any);
    // If platform has a native rootFile, use that name; otherwise AGENTS.md is irrelevant for this platform
    if (def && def.rootFile) {
      return def.rootFile;
    }
    return null;
  }

  const originalBase = basename(file.registryPath, FILE_PATTERNS.MD_FILES);
  return join(dirname(file.registryPath) || '', `${originalBase}.${platformName}${FILE_PATTERNS.MD_FILES}`);
}

/**
 * Add files as platform-specific to the result
 */
function addFilesAsPlatformSpecific(files: DiscoveredFile[], result: ContentAnalysisResult): void {
  for (const file of files) {
    const platformName = getPlatformNameFromSource(file.sourceDir);
    const platformSpecificPath = createPlatformSpecificPath(file, platformName);

    // Skip if AGENTS.md is irrelevant for this platform (no native rootFile)
    if (!platformSpecificPath) {
      continue;
    }

    result.platformSpecificFiles.push({
      file,
      platformName,
      finalRegistryPath: platformSpecificPath
    });
  }
}

/**
 * Standard conflict resolution algorithm (fallback)
 */
function analyzeNormalConflictsStandard(files: DiscoveredFile[]): ContentAnalysisResult {
  const result: ContentAnalysisResult = {
    universalFiles: [],
    platformSpecificFiles: []
  };

  // Group files by content hash
  const contentGroups = new Map<string, DiscoveredFile[]>();
  for (const file of files) {
    if (!contentGroups.has(file.contentHash)) {
      contentGroups.set(file.contentHash, []);
    }
    contentGroups.get(file.contentHash)!.push(file);
  }

  // If all files have the same hash (identical content)
  if (contentGroups.size === 1) {
    const hashGroup = Array.from(contentGroups.values())[0];
    const latestFile = findLatestFile(hashGroup);
    result.universalFiles.push({
      file: latestFile,
      finalRegistryPath: latestFile.registryPath
    });
    return result;
  }

  // Check if all files have the same mtime
  const mtimes = files.map(f => f.mtime);
  const uniqueMtimes = Array.from(new Set(mtimes));
  const allSameMtime = uniqueMtimes.length === 1;

  if (allSameMtime) {
    // Same mtime, different content - analyze hash frequency
    const hashCounts = new Map<string, number>();
    for (const file of files) {
      hashCounts.set(file.contentHash, (hashCounts.get(file.contentHash) || 0) + 1);
    }

    // Find maximum count
    const maxCount = Math.max(...Array.from(hashCounts.values()));

    // Find all hash groups with maximum count
    const maxCountHashes = Array.from(hashCounts.entries())
      .filter(([_, count]) => count === maxCount)
      .map(([hash, _]) => hash);

    if (maxCount >= 2) {
      // Universal content (appears in >= 2 platforms)
      for (const hash of maxCountHashes) {
        const hashGroup = contentGroups.get(hash)!;
        const latestFile = findLatestFile(hashGroup);
        result.universalFiles.push({
          file: latestFile,
          finalRegistryPath: latestFile.registryPath
        });
      }

      // Platform-specific content (other hashes)
      for (const [hash, hashGroup] of Array.from(contentGroups.entries())) {
        if (!maxCountHashes.includes(hash)) {
          addFilesAsPlatformSpecific(hashGroup, result);
        }
      }
    } else {
      // All files are platform-specific (max count < 2)
      addFilesAsPlatformSpecific(files, result);
    }
  } else {
    // Different mtimes - find files with maximum mtime
    const maxMtime = Math.max(...mtimes);
    const maxMtimeFiles = files.filter(f => f.mtime === maxMtime);

    if (maxMtimeFiles.length === 1) {
      // Single latest file becomes universal
      result.universalFiles.push({
        file: maxMtimeFiles[0],
        finalRegistryPath: maxMtimeFiles[0].registryPath
      });
    } else {
      // Multiple files with same latest mtime - all become platform-specific
      addFilesAsPlatformSpecific(maxMtimeFiles, result);
    }
  }

  return result;
}

/**
 * Log conflict resolution decisions
 */
export function logConflictResolution(
  registryPath: string,
  originalFiles: DiscoveredFile[],
  analysisResult: ContentAnalysisResult,
  silent?: boolean
): void {
  if (silent) {
    return;
  }
  const totalFiles = originalFiles.length;
  const universalCount = analysisResult.universalFiles.length;
  const platformSpecificCount = analysisResult.platformSpecificFiles.length;

  console.log(`📄 Processed conflicts for ${registryPath} (${totalFiles} files)`);

  if (universalCount > 0) {
    console.log(`  ✓ Universal: ${universalCount} file(s) saved without prefix`);
  }

  if (platformSpecificCount > 0) {
    console.log(`  ✓ Platform-specific: ${platformSpecificCount} file(s) saved with platform prefixes`);
  }

  // For interactive resolution, all files are accounted for
  const processedFiles = universalCount + platformSpecificCount;
  if (processedFiles < totalFiles) {
    const synchronizedFiles = totalFiles - processedFiles;
    console.log(`  🔄 Synchronized: ${synchronizedFiles} file(s) updated with universal content`);
  }
}

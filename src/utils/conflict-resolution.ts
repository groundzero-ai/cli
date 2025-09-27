/**
 * Conflict Resolution Module
 * Utility functions for resolving file conflicts during formula saving
 */

import { join, basename, dirname } from 'path';
import { logger } from './logger.js';
import { getPlatformNameFromSource } from './platform-utils.js';
import type { DiscoveredFile, ContentAnalysisResult } from '../types/index.js';

/**
 * Enhanced conflict resolution using content-based analysis
 */
export function resolveFileConflicts(discoveredFiles: DiscoveredFile[]): DiscoveredFile[] {
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
      const analysisResult = analyzeContentConflicts(files);

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

      // Log resolution decisions
      logConflictResolution(registryPath, files, analysisResult);
    }
  }

  return resolvedFiles;
}

/**
 * Analyze content conflicts and determine resolution strategy
 */
export function analyzeContentConflicts(files: DiscoveredFile[]): ContentAnalysisResult {
  const result: ContentAnalysisResult = {
    universalFiles: [],
    platformSpecificFiles: []
  };

  // Separate platform-specific files from normal files
  const platformSpecificFiles = files.filter(f => f.forcePlatformSpecific);
  const normalFiles = files.filter(f => !f.forcePlatformSpecific);

  // Handle platform-specific files - each gets platform prefix
  for (const file of platformSpecificFiles) {
    const platformName = getPlatformNameFromSource(file.sourceDir);
    const originalBase = basename(file.registryPath, '.md');
    const platformSpecificPath = join(dirname(file.registryPath) || '', `${originalBase}.${platformName}.md`);

    result.platformSpecificFiles.push({
      file,
      platformName,
      finalRegistryPath: platformSpecificPath
    });
  }

  // Handle normal files with existing logic
  if (normalFiles.length > 0) {
    const normalResult = analyzeNormalConflicts(normalFiles);
    result.universalFiles.push(...normalResult.universalFiles);
    result.platformSpecificFiles.push(...normalResult.platformSpecificFiles);
  }

  return result;
}

/**
 * Analyze conflicts for normal (non-platform-specific) files
 */
function analyzeNormalConflicts(files: DiscoveredFile[]): ContentAnalysisResult {
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
    const latestFile = hashGroup.reduce((latest, current) =>
      current.mtime > latest.mtime ? current : latest
    );
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
    let maxCount = 0;
    for (const count of Array.from(hashCounts.values())) {
      maxCount = Math.max(maxCount, count);
    }

    // Find all hash groups with maximum count
    const maxCountHashes = Array.from(hashCounts.entries())
      .filter(([_, count]) => count === maxCount)
      .map(([hash, _]) => hash);

    if (maxCount >= 2) {
      // Universal content (appears in >= 2 platforms)
      for (const hash of maxCountHashes) {
        const hashGroup = contentGroups.get(hash)!;
        const latestFile = hashGroup.reduce((latest, current) =>
          current.mtime > latest.mtime ? current : latest
        );
        result.universalFiles.push({
          file: latestFile,
          finalRegistryPath: latestFile.registryPath
        });
      }

      // Platform-specific content (other hashes)
      for (const [hash, hashGroup] of Array.from(contentGroups.entries())) {
        if (!maxCountHashes.includes(hash)) {
          for (const file of hashGroup) {
            const platformName = getPlatformNameFromSource(file.sourceDir);
            const originalBase = basename(file.registryPath, '.md');
            const platformSpecificPath = join(dirname(file.registryPath) || '', `${originalBase}.${platformName}.md`);

            result.platformSpecificFiles.push({
              file,
              platformName,
              finalRegistryPath: platformSpecificPath
            });
          }
        }
      }
    } else {
      // All files are platform-specific (max count < 2)
      for (const file of files) {
        const platformName = getPlatformNameFromSource(file.sourceDir);
        const originalBase = basename(file.registryPath, '.md');
        const platformSpecificPath = join(dirname(file.registryPath) || '', `${originalBase}.${platformName}.md`);

        result.platformSpecificFiles.push({
          file,
          platformName,
          finalRegistryPath: platformSpecificPath
        });
      }
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
      for (const file of maxMtimeFiles) {
        const platformName = getPlatformNameFromSource(file.sourceDir);
        const originalBase = basename(file.registryPath, '.md');
        const platformSpecificPath = join(dirname(file.registryPath) || '', `${originalBase}.${platformName}.md`);

        result.platformSpecificFiles.push({
          file,
          platformName,
          finalRegistryPath: platformSpecificPath
        });
      }
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
  analysisResult: ContentAnalysisResult
): void {
  const totalFiles = originalFiles.length;
  const universalCount = analysisResult.universalFiles.length;
  const platformSpecificCount = analysisResult.platformSpecificFiles.length;

  console.log(`📄 Resolving conflicts for ${registryPath} (${totalFiles} files)`);

  if (universalCount > 0) {
    console.log(`  ✓ Universal: ${universalCount} file(s) saved without prefix`);
  }

  if (platformSpecificCount > 0) {
    console.log(`  ✓ Platform-specific: ${platformSpecificCount} file(s) saved with platform prefixes`);
  }

  // Log skipped files
  const keptFiles = new Set([
    ...analysisResult.universalFiles.map(u => u.file.fullPath),
    ...analysisResult.platformSpecificFiles.map(p => p.file.fullPath)
  ]);

  const skippedFiles = originalFiles.filter(f => !keptFiles.has(f.fullPath));
  if (skippedFiles.length > 0) {
    console.log(`  ⚠️  Skipped: ${skippedFiles.length} older or duplicate file(s)`);
    for (const skipped of skippedFiles) {
      logger.debug(`Skipped ${skipped.fullPath} (content hash: ${skipped.contentHash})`);
    }
  }
}

/**
 * Root File Operations Utility
 * Utility functions for operating on root files (AGENTS.md, CLAUDE.md, etc.)
 */

import { extractPackageContentFromRootFile } from './root-file-extractor.js';
import { mergePackageContentIntoRootFile } from './root-file-merger.js';
import { readTextFile, writeTextFile } from './fs.js';
import { logger } from './logger.js';
import { getPathLeaf } from './path-normalization.js';

/**
 * Result of processing a root file operation
 */
export interface RootFileProcessResult {
  processed: boolean;
  reason?: string;
}

/**
 * Add a package marker to a root file if not already present
 *
 * @param filePath - Path to the root file
 * @param packageName - Name of the package to add
 * @returns Result indicating if the file was processed and why
 */
export async function addPackageToRootFile(
  filePath: string,
  packageName: string
): Promise<RootFileProcessResult> {
  logger.debug(`Processing root file: ${filePath}`);

  try {
    const content = await readTextFile(filePath);

    // Check if package marker already exists
    const existingContent = extractPackageContentFromRootFile(content, packageName);
    if (existingContent !== null) {
      console.log(`✓ Package '${packageName}' is already added to ${getPathLeaf(filePath)}`);
      return { processed: false, reason: 'already_exists' };
    }

    // Add empty marker section at the end
    const updatedContent = mergePackageContentIntoRootFile(content, packageName, '');
    await writeTextFile(filePath, updatedContent);

    console.log(`✓ Added package marker for '${packageName}' to ${getPathLeaf(filePath)}`);
    return { processed: true };

  } catch (error) {
    logger.error(`Failed to process root file: ${filePath}`, { error });
    console.log(`✗ Failed to process ${getPathLeaf(filePath)}: ${error}`);
    return { processed: false, reason: 'error' };
  }
}

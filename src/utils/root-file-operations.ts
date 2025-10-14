/**
 * Root File Operations Utility
 * Utility functions for operating on root files (AGENTS.md, CLAUDE.md, etc.)
 */

import { extractFormulaContentFromRootFile } from './root-file-extractor.js';
import { mergeFormulaContentIntoRootFile } from './root-file-merger.js';
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
 * Add a formula marker to a root file if not already present
 *
 * @param filePath - Path to the root file
 * @param formulaName - Name of the formula to add
 * @returns Result indicating if the file was processed and why
 */
export async function addFormulaToRootFile(
  filePath: string,
  formulaName: string
): Promise<RootFileProcessResult> {
  logger.debug(`Processing root file: ${filePath}`);

  try {
    const content = await readTextFile(filePath);

    // Check if formula marker already exists
    const existingContent = extractFormulaContentFromRootFile(content, formulaName);
    if (existingContent !== null) {
      console.log(`✓ Formula '${formulaName}' is already added to ${getPathLeaf(filePath)}`);
      return { processed: false, reason: 'already_exists' };
    }

    // Add empty marker section at the end
    const updatedContent = mergeFormulaContentIntoRootFile(content, formulaName, '');
    await writeTextFile(filePath, updatedContent);

    console.log(`✓ Added formula marker for '${formulaName}' to ${getPathLeaf(filePath)}`);
    return { processed: true };

  } catch (error) {
    logger.error(`Failed to process root file: ${filePath}`, { error });
    console.log(`✗ Failed to process ${getPathLeaf(filePath)}: ${error}`);
    return { processed: false, reason: 'error' };
  }
}

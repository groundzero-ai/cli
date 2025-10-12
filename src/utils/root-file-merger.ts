/**
 * Root File Content Merger Utility
 * Handles marker-based content merging for root files (AGENTS.md, CLAUDE.md, etc.)
 */

import { buildOpenMarker, buildOpenMarkerRegex, CLOSE_MARKER, CLOSE_MARKER_REGEX, extractAllFormulaSections, extractFormulaContentFromRootFile, isMarkerWrappedContent } from './root-file-extractor.js';

/**
 * Merge formula-specific content into a root file while preserving all other content.
 * Finds the formula section between markers and replaces it, or appends if not found.
 * 
 * @param existingContent - The current content of the root file (or empty string)
 * @param formulaName - Name of the formula to merge
 * @param newContent - New content to insert between the markers (or marker-wrapped content)
 * @returns Updated root file content with formula section merged
 */
export function mergeFormulaContentIntoRootFile(
  existingContent: string,
  formulaName: string,
  newContent: string
): string {
  if (!formulaName) {
    throw new Error('Formula name is required for merging');
  }

  // Check if newContent is already marker-wrapped (from registry)
  const isMarkerWrapped = isMarkerWrappedContent(newContent, formulaName);
  
  if (isMarkerWrapped) {
    // Extract the section body from marker-wrapped content
    const extracted = extractFormulaContentFromRootFile(newContent, formulaName);
    if (!extracted) {
      throw new Error('Invalid marker-wrapped content');
    }
    newContent = extracted;
  }

  const openMarker = buildOpenMarker(formulaName);
  const closeMarker = CLOSE_MARKER;
  
  // Create regex to find existing formula section
  const openRe = buildOpenMarkerRegex(formulaName);
  const closeRe = CLOSE_MARKER_REGEX;

  const openMatch = openRe.exec(existingContent);
  
  if (!openMatch) {
    // Formula section doesn't exist - append it
    const separator = existingContent.trim() ? '\n\n' : '';
    return existingContent.trim() + separator + openMarker + '\n' + newContent.trim() + '\n' + closeMarker + '\n';
  }

  // Formula section exists - replace it
  const beforeSection = existingContent.substring(0, openMatch.index);
  const afterMarkerIndex = openMatch.index + openMatch[0].length;
  const restContent = existingContent.substring(afterMarkerIndex);
  
  const closeMatch = closeRe.exec(restContent);
  
  if (!closeMatch) {
    // Malformed - missing closing marker, append new section at end
    const separator = existingContent.trim() ? '\n\n' : '';
    return existingContent.trim() + separator + openMarker + '\n' + newContent.trim() + '\n' + closeMarker + '\n';
  }

  // Replace the section content
  const afterCloseMarkerIndex = closeMatch.index + closeMatch[0].length;
  const afterSection = restContent.substring(afterCloseMarkerIndex);
  
  return beforeSection + openMarker + '\n' + newContent.trim() + '\n' + closeMarker + afterSection;
}


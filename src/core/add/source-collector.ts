import { relative } from 'path';

import { DIR_PATTERNS } from '../../constants/index.js';
import { isDirectory, isFile, walkFiles } from '../../utils/fs.js';
import { normalizePathForProcessing } from '../../utils/path-normalization.js';
import { mapPlatformFileToUniversal } from '../../utils/platform-mapper.js';
import { isPlatformRootFile } from '../../utils/platform-utils.js';

export interface SourceEntry {
  sourcePath: string;
  registryPath: string;
}

export async function collectSourceEntries(resolvedPath: string, cwd: string): Promise<SourceEntry[]> {
  const entries: SourceEntry[] = [];

  if (await isDirectory(resolvedPath)) {
    for await (const filePath of walkFiles(resolvedPath)) {
      const entry = deriveSourceEntry(filePath, cwd);
      if (!entry) {
        throw new Error(`Unsupported file inside directory: ${relative(cwd, filePath)}`);
      }
      entries.push(entry);
    }
    return entries;
  }

  if (await isFile(resolvedPath)) {
    const entry = deriveSourceEntry(resolvedPath, cwd);
    if (!entry) {
      throw new Error(`Unsupported file: ${relative(cwd, resolvedPath)}`);
    }
    entries.push(entry);
    return entries;
  }

  throw new Error(`Unsupported path type: ${resolvedPath}`);
}

function deriveSourceEntry(absFilePath: string, cwd: string): SourceEntry | null {
  const relativePath = relative(cwd, absFilePath);
  const normalizedRelPath = normalizePathForProcessing(relativePath);

  // Check if this is a platform-specific file (e.g., .cursor/commands/test.md)
  const mapping = mapPlatformFileToUniversal(absFilePath);
  if (mapping) {
    // Universal content: prefix with .openpackage/
    return {
      sourcePath: absFilePath,
      registryPath: [DIR_PATTERNS.OPENPACKAGE, mapping.subdir, mapping.relPath].filter(Boolean).join('/')
    };
  }

  // Check if this is a platform root file (e.g., AGENTS.md, CLAUDE.md)
  const fileName = normalizedRelPath.split('/').pop();
  if (fileName && isPlatformRootFile(fileName) && !normalizedRelPath.includes('/')) {
    // Root files: no prefix, stored at package root
    return {
      sourcePath: absFilePath,
      registryPath: fileName
    };
  }

  // All other files: root-level content, no .openpackage/ prefix
  // Stored at package root, outside .openpackage/
  return {
    sourcePath: absFilePath,
    registryPath: normalizedRelPath
  };
}


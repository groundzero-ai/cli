import { relative } from 'path';

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

  const mapping = mapPlatformFileToUniversal(absFilePath);
  if (mapping) {
    return {
      sourcePath: absFilePath,
      registryPath: [mapping.subdir, mapping.relPath].filter(Boolean).join('/')
    };
  }

  const fileName = normalizedRelPath.split('/').pop();
  if (fileName && isPlatformRootFile(fileName) && !normalizedRelPath.includes('/')) {
    return {
      sourcePath: absFilePath,
      registryPath: fileName
    };
  }

  return {
    sourcePath: absFilePath,
    registryPath: normalizedRelPath
  };
}


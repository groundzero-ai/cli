import { discoverAllRootFiles } from '../../utils/formula-discovery.js';
import { discoverPlatformFilesUnified } from '../discovery/platform-files-discovery.js';
import type { SaveDiscoveredFile } from '../../types/index.js';

export async function discoverFormulaFilesForSave(formulaName: string): Promise<SaveDiscoveredFile[]> {
  const cwd = process.cwd();
  const discoveredFiles: SaveDiscoveredFile[] = [];

  const platformFiles = await discoverPlatformFilesUnified(cwd, formulaName);
  discoveredFiles.push(...platformFiles);

  const rootFiles = await discoverAllRootFiles(cwd, formulaName);
  discoveredFiles.push(...rootFiles);

  return discoveredFiles;
}



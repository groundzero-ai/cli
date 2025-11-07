import { join } from 'path';

import { FILE_PATTERNS } from '../../constants/index.js';
import { discoverAllRootFiles } from '../../utils/formula-discovery.js';
import { exists, readTextFile } from '../../utils/fs.js';
import { getFileMtime } from '../../utils/file-processing.js';
import { calculateFileHash } from '../../utils/hash-utils.js';
import { logger } from '../../utils/logger.js';
import { ensureRootMarkerIdAndExtract } from '../../utils/root-file-extractor.js';
import { SaveCandidate } from './save-candidate-types.js';
import { getAllPlatforms, getPlatformDefinition } from '../platforms.js';

export async function loadLocalRootSaveCandidates(
  formulaDir: string,
  formulaName: string
): Promise<SaveCandidate[]> {
  const candidates: SaveCandidate[] = [];
  const rootFileNames = getCandidateRootFileNames();

  for (const fileName of rootFileNames) {
    const fullPath = join(formulaDir, fileName);
    if (!(await exists(fullPath))) {
      continue;
    }

    try {
      const content = await readTextFile(fullPath);
      const ensured = ensureRootMarkerIdAndExtract(content, formulaName);
      const sectionBody = ensured?.sectionBody?.trim() ?? content.trim();
      const markerId = ensured?.id;
      const contentHash = await calculateFileHash(sectionBody);
      const mtime = await getFileMtime(fullPath);

      candidates.push({
        source: 'local',
        registryPath: FILE_PATTERNS.AGENTS_MD,
        fullPath,
        content: sectionBody,
        contentHash,
        mtime,
        displayPath: fileName,
        sectionBody,
        markerId,
        isRootFile: true,
        originalContent: content
      });

      break;
    } catch (error) {
      logger.warn(`Failed to load local root candidate ${fileName}: ${error}`);
    }
  }

  return candidates;
}

export async function discoverWorkspaceRootSaveCandidates(
  cwd: string,
  formulaName: string
): Promise<SaveCandidate[]> {
  const discovered = await discoverAllRootFiles(cwd, formulaName);
  const candidates: SaveCandidate[] = [];

  for (const file of discovered) {
    try {
      const content = await readTextFile(file.fullPath);
      const ensured = ensureRootMarkerIdAndExtract(content, formulaName);
      const sectionBody = ensured?.sectionBody?.trim();

      if (!sectionBody) {
        continue;
      }

      const markerId = ensured?.id;
      const hash = file.contentHash || (await calculateFileHash(sectionBody));

      candidates.push({
        source: 'workspace',
        registryPath: FILE_PATTERNS.AGENTS_MD,
        fullPath: file.fullPath,
        content: sectionBody,
        contentHash: hash,
        mtime: file.mtime,
        displayPath: file.relativePath,
        sectionBody,
        markerId,
        isRootFile: true,
        originalContent: content
      });
    } catch (error) {
      logger.warn(`Failed to process workspace root candidate ${file.relativePath}: ${error}`);
    }
  }

  return candidates;
}

function getCandidateRootFileNames(): string[] {
  const names = new Set<string>();
  names.add(FILE_PATTERNS.AGENTS_MD);

  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) {
      names.add(def.rootFile);
    }
  }

  const ordered = Array.from(names.values());
  ordered.sort((a, b) => {
    if (a === FILE_PATTERNS.AGENTS_MD) return -1;
    if (b === FILE_PATTERNS.AGENTS_MD) return 1;
    return a.localeCompare(b);
  });

  return ordered;
}


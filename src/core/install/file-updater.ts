import { dirname } from 'path';
import { ensureDir, exists, readTextFile, writeTextFile } from '../../utils/fs.js';

export type UpsertOutcome = 'created' | 'updated' | 'unchanged';

/**
 * Ensure directory exists and write file only if content changed.
 * Returns outcome for created/updated/unchanged.
 */
export async function writeIfChanged(absFile: string, content: string): Promise<UpsertOutcome> {
  await ensureDir(dirname(absFile));

  const fileExists = await exists(absFile);
  if (!fileExists) {
    await writeTextFile(absFile, content, 'utf8');
    return 'created';
  }

  let existingContent = '';
  try {
    existingContent = await readTextFile(absFile, 'utf8');
  } catch {
    // If read fails, treat as different to ensure write proceeds
    existingContent = '';
  }

  if (existingContent !== content) {
    await writeTextFile(absFile, content, 'utf8');
    return 'updated';
  }

  return 'unchanged';
}



import type { FormulaFile } from '../../types/index.js';
import type { FormulaYmlInfo } from './formula-yml-generator.js';
import {
  resolveFormulaFilesWithConflicts,
  type SaveConflictResolutionOptions
} from './save-conflict-resolution.js';

export async function discoverFormulaFilesForSave(
  formulaInfo: FormulaYmlInfo,
  options: SaveConflictResolutionOptions = {}
): Promise<FormulaFile[]> {
  return await resolveFormulaFilesWithConflicts(formulaInfo, options);
}
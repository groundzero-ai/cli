import { parsePackageInput } from '../../utils/package-name.js';
import { ValidationError } from '../../utils/errors.js';
import { resolveEffectiveNameForSave } from '../scoping/package-scoping.js';
import { MODE_LABELS } from './constants.js';

export type RenameReason = 'explicit' | 'scoping';
export type SaveMode = 'wip' | 'stable';

export interface ResolvedWorkspaceNames {
  inputName: string;
  finalName: string;
  needsRename: boolean;
  renameReason?: RenameReason;
}

export async function resolveWorkspaceNames(
  packageInput: string,
  renameOption: string | undefined,
  mode: SaveMode
): Promise<ResolvedWorkspaceNames> {
  const { name: inputName, version } = parsePackageInput(packageInput);
  if (version) {
    throw new ValidationError(
      `${MODE_LABELS[mode].label} command does not accept explicit versions. Edit package.yml to change the stable line.`
    );
  }

  if (renameOption?.trim()) {
    const { name: renameName, version: renameVersion } = parsePackageInput(renameOption.trim());
    if (renameVersion) {
      throw new ValidationError('Rename target cannot include a version.');
    }

    const needsRename = renameName !== inputName;
    return {
      inputName,
      finalName: renameName,
      needsRename,
      renameReason: needsRename ? 'explicit' : undefined
    };
  }

  const scopingResult = await resolveEffectiveNameForSave(inputName);

  return {
    inputName,
    finalName: scopingResult.effectiveName,
    needsRename: scopingResult.nameChanged,
    renameReason: scopingResult.nameChanged ? 'scoping' : undefined
  };
}


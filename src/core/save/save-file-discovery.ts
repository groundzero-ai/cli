import type { PackageFile } from '../../types/index.js';
import type { PackageYmlInfo } from './package-yml-generator.js';
import {
  resolvePackageFilesWithConflicts,
  type SaveConflictResolutionOptions
} from './save-conflict-resolution.js';

export async function discoverPackageFilesForSave(
  packageInfo: PackageYmlInfo,
  options: SaveConflictResolutionOptions = {}
): Promise<PackageFile[]> {
  return await resolvePackageFilesWithConflicts(packageInfo, options);
}
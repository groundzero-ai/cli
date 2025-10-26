import { join } from 'path';
import { InstallOptions } from '../types/index.js';
import { ResolvedFormula } from '../core/dependency-resolver.js';
import { checkExistingFormulaInMarkdownFiles } from '../core/groundzero.js';
import { parseFormulaYml } from './formula-yml.js';
import { exists } from './fs.js';
import { logger } from './logger.js';
import { getLocalFormulaDir } from './paths.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { getVersionInfoFromDependencyTree } from './install-helpers.js';

/**
 * Get currently installed version from .groundzero/formulas/<formula>/formula.yml
 */
async function getInstalledFormulaVersion(cwd: string, formulaName: string): Promise<string | undefined> {
  try {
    const formulaDir = getLocalFormulaDir(cwd, formulaName);
    const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
    if (await exists(formulaYmlPath)) {
      const config = await parseFormulaYml(formulaYmlPath);
      return config.version;
    }
  } catch {
    // ignore parse errors; treat as unknown
  }
  return undefined;
}

/**
 * Check for existing formula and handle conflict resolution
 */
export async function checkAndHandleFormulaConflict(
  formulaName: string,
  newVersion: string,
  resolvedFormulas: ResolvedFormula[],
  options: InstallOptions
): Promise<{ shouldProceed: boolean; action: 'keep' | 'latest' | 'exact' | 'none'; version?: string; forceOverwrite?: boolean }> {
  const cwd = process.cwd();
  
  // Check for existing formula in markdown files
  const existingCheck = await checkExistingFormulaInMarkdownFiles(cwd, formulaName);
  
  if (!existingCheck.found) {
    // No existing formula found, proceed without warning or prompts
    logger.debug(`No existing formula '${formulaName}' found, proceeding with installation`);
    return { shouldProceed: true, action: 'none', forceOverwrite: false };
  }
  
  // Existing formula found, get version info from dependency tree
  const versionInfo = await getVersionInfoFromDependencyTree(formulaName, resolvedFormulas);
  const existingVersion = existingCheck.version || await getInstalledFormulaVersion(cwd, formulaName);
  
  if (existingVersion) {
    logger.debug(`Found existing formula '${formulaName}' v${existingVersion} in ${existingCheck.location}`);
  } else {
    logger.debug(`Found existing formula '${formulaName}' in ${existingCheck.location}`);
  }
  
  if (options.dryRun) {
    // In dry run mode, proceed without forcing; per-file logic will report decisions
    return { shouldProceed: true, action: 'latest', forceOverwrite: false };
  }
  
  if (options.force) {
    // When --force is used, automatically overwrite
    logger.info(`Force flag set - automatically overwriting formula '${formulaName}' v${existingVersion}`);
    return { shouldProceed: true, action: 'latest', forceOverwrite: true };
  }
  
  // Proceed without prompting; per-file frontmatter-aware logic will handle overwrite decisions
  logger.info(`Proceeding without global prompt for '${formulaName}'; per-file frontmatter will govern overwrites.`);
  return { shouldProceed: true, action: 'latest', forceOverwrite: false };
}

/**
 * Check for conflicts with all formulas in the dependency tree
 */
export async function checkAndHandleAllFormulaConflicts(
  resolvedFormulas: ResolvedFormula[],
  options: InstallOptions
): Promise<{ shouldProceed: boolean; skippedFormulas: string[]; forceOverwriteFormulas: Set<string> }> {
  const cwd = process.cwd();
  const skippedFormulas: string[] = [];
  const forceOverwriteFormulas = new Set<string>();
  
  // Check each formula in the dependency tree for conflicts
  for (const resolved of resolvedFormulas) {
    const existingCheck = await checkExistingFormulaInMarkdownFiles(cwd, resolved.name);
    
    if (existingCheck.found) {
      const versionInfo = await getVersionInfoFromDependencyTree(resolved.name, resolvedFormulas);
      const existingVersion = existingCheck.version || await getInstalledFormulaVersion(cwd, resolved.name);
      
      if (existingVersion) {
        logger.debug(`Found existing formula '${resolved.name}' v${existingVersion} in ${existingCheck.location}`);
      } else {
        logger.debug(`Found existing formula '${resolved.name}' in ${existingCheck.location}`);
      }
      
      if (options.dryRun) {
        // In dry run mode, proceed; per-file logic will report decisions
        continue;
      }
      
      if (options.force) {
        // When --force is used, automatically overwrite all conflicts
        logger.info(`Force flag set - automatically overwriting formula '${resolved.name}' v${existingVersion}`);
        forceOverwriteFormulas.add(resolved.name);
        continue;
      }
      
      // Prompt per formula overwrite confirmation when existing detected
      const { promptFormulaOverwrite } = await import('./prompts.js');
      const confirmed = await promptFormulaOverwrite(resolved.name, existingVersion);
      if (confirmed) {
        forceOverwriteFormulas.add(resolved.name);
      } else {
        skippedFormulas.push(resolved.name);
      }
      continue;
    }
  }
  
  return { shouldProceed: true, skippedFormulas, forceOverwriteFormulas };
}

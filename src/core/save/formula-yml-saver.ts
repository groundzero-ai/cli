import { join } from "path";
import { FILE_PATTERNS } from "../../constants";
import { FormulaYml } from "../../types";
import { areFormulaNamesEquivalent, normalizeFormulaName } from "../../utils/formula-name-normalization";
import { parseFormulaYml, writeFormulaYml } from "../../utils/formula-yml";
import { ensureDir, exists } from "../../utils/fs";
import { logger } from "../../utils/logger";
import { getLocalFormulaDir, getLocalFormulaYmlPath } from "../../utils/paths";
import { ValidationError } from "../../utils/errors";
import { createBasicFormulaYml, ensureLocalGroundZeroStructure } from "../../utils/formula-management";
import { hasFormulaVersion } from "../directory";
import { DEFAULT_VERSION, ERROR_MESSAGES, LOG_PREFIXES } from "./constants";
import { determineTargetVersion } from "./formula-yml-versioning";

export type FormulaYmlInfo = {
  fullPath: string;
  config: FormulaYml;
  isNewFormula: boolean;
  isRootFormula: boolean;
};

/**
 * Create formula.yml automatically in a directory without user prompts
 * Reuses init command logic but makes it non-interactive
 */
async function createFormulaYmlInDirectory(formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean }> {
  const cwd = process.cwd();
  
  // Ensure the target directory exists (including formulas subdirectory)
  await ensureLocalGroundZeroStructure(cwd);
  await ensureDir(formulaDir);
  
  // Create formula.yml in the formula directory (not the main .groundzero directory)
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
  
  // Create default formula config
  const formulaConfig: FormulaYml = {
    name: normalizeFormulaName(formulaName),
    version: DEFAULT_VERSION
  };
  
  // Create the formula.yml file
  await writeFormulaYml(formulaYmlPath, formulaConfig);
  console.log(`${LOG_PREFIXES.CREATED} ${formulaDir}`);
  console.log(`${LOG_PREFIXES.NAME} ${formulaConfig.name}`);
  console.log(`${LOG_PREFIXES.VERSION} ${formulaConfig.version}`);
  
  return {
    fullPath: formulaYmlPath,
    config: formulaConfig,
    isNewFormula: true
  };
}

/**
 * Get or create formula configuration in the specified directory
 * @param cwd - Current working directory
 * @param formulaDir - Directory where formula.yml should be located
 * @param formulaName - Name of the formula
 * @returns Formula configuration info
 */
async function getOrCreateFormulaConfig(cwd: string, formulaDir: string, formulaName: string): Promise<FormulaYmlInfo> {
  // Check if this is a root formula
  const rootFormulaPath = getLocalFormulaYmlPath(cwd);
  if (await exists(rootFormulaPath)) {
    try {
      const rootConfig = await parseFormulaYml(rootFormulaPath);
      if (areFormulaNamesEquivalent(rootConfig.name, formulaName)) {
        logger.debug('Detected root formula match');
        console.log(`✓ Found root formula ${rootConfig.name}@${rootConfig.version}`);
        return {
          fullPath: rootFormulaPath,
          config: rootConfig,
          isNewFormula: false,
          isRootFormula: true
        };
      }
    } catch (error) {
      // If root formula.yml is invalid, continue to sub-formula logic
      logger.warn(`Failed to parse root formula.yml: ${error}`);
    }
  }

  // Not a root formula - use sub-formula logic
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    logger.debug('Found existing formula.yml, parsing...');
    try {
      const formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(`✓ Found existing formula ${formulaConfig.name}@${formulaConfig.version}`);

      return {
        fullPath: formulaYmlPath,
        config: formulaConfig,
        isNewFormula: false,
        isRootFormula: false
      };
    } catch (error) {
      throw new ValidationError(ERROR_MESSAGES.PARSE_FORMULA_FAILED.replace('%s', formulaYmlPath).replace('%s', String(error)));
    }
  } else {
    logger.debug('No formula.yml found, creating automatically...');
    const result = await createFormulaYmlInDirectory(formulaDir, formulaName);
    return {
      ...result,
      isRootFormula: false
    };
  }
}



export async function getOrCreateFormulaYml(
  cwd: string,
  name: string,
  explicitVersion?: string,
  versionType?: string,
  bump?: 'patch' | 'minor' | 'major',
  force?: boolean
): Promise<FormulaYml> {
  await createBasicFormulaYml(cwd);

  // Get formula configuration based on input pattern
  const formulaDir = getLocalFormulaDir(cwd, name);
  const formulaInfo = await getOrCreateFormulaConfig(cwd, formulaDir, name);
  let formulaConfig = formulaInfo.config;

  logger.debug(`Found formula.yml at: ${formulaInfo.fullPath}`);

  // Determine target version
  const targetVersion = await determineTargetVersion(explicitVersion, versionType, bump, formulaInfo.isNewFormula ? undefined : formulaConfig.version);

  // Check if version already exists (unless force is used)
  if (!force) {
    const versionExists = await hasFormulaVersion(name, targetVersion);
    if (versionExists) {
      throw new Error(ERROR_MESSAGES.VERSION_EXISTS.replace('%s', targetVersion));
    }
  }

  // Update formula config with new version
  formulaConfig = { ...formulaConfig, version: targetVersion };

  return formulaConfig;
}
import { join } from "path";
import { FILE_PATTERNS } from "../../constants/index.js";
import { FormulaYml } from "../../types";
import { normalizeFormulaName } from "../../utils/formula-name.js";
import { parseFormulaYml, writeFormulaYml } from "../../utils/formula-yml.js";
import { ensureDir, exists, isDirectory } from "../../utils/fs.js";
import { logger } from "../../utils/logger.js";
import { getLocalFormulaDir } from "../../utils/paths.js";
import { ValidationError } from "../../utils/errors.js";
import { ensureLocalGroundZeroStructure } from "../../utils/formula-management.js";
import { hasFormulaVersion } from "../directory.js";
import { DEFAULT_VERSION, ERROR_MESSAGES, LOG_PREFIXES } from "./constants.js";
import { determineTargetVersion } from "./formula-yml-versioning.js";

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

export async function getOrCreateFormulaYml(
  cwd: string,
  name: string,
  explicitVersion?: string,
  versionType?: string,
  bump?: "patch" | "minor" | "major",
  force?: boolean
): Promise<FormulaYmlInfo> {
  await ensureLocalGroundZeroStructure(cwd);

  const formulaDir = getLocalFormulaDir(cwd, name);
  if (!(await exists(formulaDir)) || !(await isDirectory(formulaDir))) {
    // Create the formula directory if it doesn't exist
    await ensureDir(formulaDir);
    logger.debug("Created formula directory for save", { path: formulaDir });
  }

  const normalizedName = normalizeFormulaName(name);
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  let formulaConfig: FormulaYml;
  let isNewFormula = false;

  if (await exists(formulaYmlPath)) {
    logger.debug("Found existing formula.yml for save", { path: formulaYmlPath });
    try {
      formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(`✓ Found existing formula ${formulaConfig.name}@${formulaConfig.version}`);
    } catch (error) {
      throw new ValidationError(
        ERROR_MESSAGES.PARSE_FORMULA_FAILED.replace("%s", formulaYmlPath).replace("%s", String(error))
      );
    }
  } else {
    logger.debug("No formula.yml found for save, creating", { dir: formulaDir });
    const created = await createFormulaYmlInDirectory(formulaDir, normalizedName);
    formulaConfig = created.config;
    isNewFormula = true;
  }

  const targetVersion = await determineTargetVersion(
    explicitVersion,
    versionType,
    bump,
    isNewFormula ? undefined : formulaConfig.version
  );

  if (!force) {
    const versionExists = await hasFormulaVersion(normalizedName, targetVersion);
    if (versionExists) {
      throw new Error(ERROR_MESSAGES.VERSION_EXISTS.replace("%s", targetVersion));
    }
  }

  const updatedConfig: FormulaYml = {
    ...formulaConfig,
    name: normalizedName,
    version: targetVersion
  };

  await writeFormulaYml(formulaYmlPath, updatedConfig);

  return {
    fullPath: formulaYmlPath,
    config: updatedConfig,
    isNewFormula,
    isRootFormula: false
  };
}
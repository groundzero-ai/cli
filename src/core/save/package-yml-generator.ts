import { join } from "path";
import { FILE_PATTERNS } from "../../constants/index.js";
import { PackageYml } from "../../types";
import { normalizePackageName } from "../../utils/package-name.js";
import { parsePackageYml, writePackageYml } from "../../utils/package-yml.js";
import { ensureDir, exists, isDirectory } from "../../utils/fs.js";
import { logger } from "../../utils/logger.js";
import { getLocalPackageDir } from "../../utils/paths.js";
import { ValidationError } from "../../utils/errors.js";
import { ensureLocalOpenPackageStructure } from "../../utils/package-management.js";
import { hasPackageVersion } from "../directory.js";
import { DEFAULT_VERSION, ERROR_MESSAGES, LOG_PREFIXES, WIP_SUFFIX } from "./constants.js";
import { determineTargetVersion } from "./package-yml-versioning.js";

export type PackageYmlInfo = {
  fullPath: string;
  config: PackageYml;
  isNewPackage: boolean;
  isRootPackage: boolean;
};

/**
 * Create formula.yml automatically in a directory without user prompts
 * Reuses init command logic but makes it non-interactive
 */
async function createPackageYmlInDirectory(formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: PackageYml; isNewPackage: boolean }> {
  const cwd = process.cwd();
  
  // Ensure the target directory exists (including formulas subdirectory)
  await ensureLocalOpenPackageStructure(cwd);
  await ensureDir(formulaDir);
  
  // Create formula.yml in the formula directory (rTnot the main .openpackage directory)
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
  
  // Create default formula config
  const formulaConfig: PackageYml = {
    name: normalizePackageName(formulaName),
    version: DEFAULT_VERSION
  };
  
  // Create the formula.yml file
  await writePackageYml(formulaYmlPath, formulaConfig);
  console.log(`${LOG_PREFIXES.CREATED} ${formulaDir}`);
  console.log(`${LOG_PREFIXES.NAME} ${formulaConfig.name}`);
  console.log(`${LOG_PREFIXES.VERSION} ${formulaConfig.version}`);
  
  return {
    fullPath: formulaYmlPath,
    config: formulaConfig,
    isNewPackage: true
  };
}

export async function getOrCreatePackageYml(
  cwd: string,
  name: string,
  explicitVersion?: string,
  versionType?: string,
  bump?: "patch" | "minor" | "major",
  force?: boolean
): Promise<PackageYmlInfo> {
  await ensureLocalOpenPackageStructure(cwd);

  const formulaDir = getLocalPackageDir(cwd, name);
  if (!(await exists(formulaDir)) || !(await isDirectory(formulaDir))) {
    // Create the formula directory if it doesn't exist
    await ensureDir(formulaDir);
    logger.debug("Created formula directory for save", { path: formulaDir });
  }

  const normalizedName = normalizePackageName(name);
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  let formulaConfig: PackageYml;
  let isNewPackage = false;

  if (await exists(formulaYmlPath)) {
    logger.debug("Found existing formula.yml for save", { path: formulaYmlPath });
    try {
      formulaConfig = await parsePackageYml(formulaYmlPath);
      console.log(`✓ Found existing formula ${formulaConfig.name}@${formulaConfig.version}`);
    } catch (error) {
      throw new ValidationError(
        ERROR_MESSAGES.PARSE_FORMULA_FAILED.replace("%s", formulaYmlPath).replace("%s", String(error))
      );
    }
  } else {
    logger.debug("No formula.yml found for save, creating", { dir: formulaDir });
    const created = await createPackageYmlInDirectory(formulaDir, normalizedName);
    formulaConfig = created.config;
    isNewPackage = true;
  }

  const targetVersion = await determineTargetVersion(
    explicitVersion,
    versionType,
    bump,
    isNewPackage ? undefined : formulaConfig.version
  );

  const allowOverwrite = force || targetVersion.endsWith(WIP_SUFFIX);

  if (!allowOverwrite) {
    const versionExists = await hasPackageVersion(normalizedName, targetVersion);
    if (versionExists) {
      throw new Error(ERROR_MESSAGES.VERSION_EXISTS.replace("%s", targetVersion));
    }
  }

  const updatedConfig: PackageYml = {
    ...formulaConfig,
    name: normalizedName,
    version: targetVersion
  };

  await writePackageYml(formulaYmlPath, updatedConfig);

  return {
    fullPath: formulaYmlPath,
    config: updatedConfig,
    isNewPackage,
    isRootPackage: false
  };
}
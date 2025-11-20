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
 * Create package.yml automatically in a directory without user prompts
 * Reuses init command logic but makes it non-interactive
 */
async function createPackageYmlInDirectory(packageDir: string, packageName: string): Promise<{ fullPath: string; config: PackageYml; isNewPackage: boolean }> {
  const cwd = process.cwd();
  
  // Ensure the target directory exists (including packages subdirectory)
  await ensureLocalOpenPackageStructure(cwd);
  await ensureDir(packageDir);
  
  // Create package.yml in the package directory (rTnot the main .openpackage directory)
  const packageYmlPath = join(packageDir, FILE_PATTERNS.FORMULA_YML);
  
  // Create default package config
  const packageConfig: PackageYml = {
    name: normalizePackageName(packageName),
    version: DEFAULT_VERSION
  };
  
  // Create the package.yml file
  await writePackageYml(packageYmlPath, packageConfig);
  console.log(`${LOG_PREFIXES.CREATED} ${packageDir}`);
  console.log(`${LOG_PREFIXES.NAME} ${packageConfig.name}`);
  console.log(`${LOG_PREFIXES.VERSION} ${packageConfig.version}`);
  
  return {
    fullPath: packageYmlPath,
    config: packageConfig,
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

  const packageDir = getLocalPackageDir(cwd, name);
  if (!(await exists(packageDir)) || !(await isDirectory(packageDir))) {
    // Create the package directory if it doesn't exist
    await ensureDir(packageDir);
    logger.debug("Created package directory for save", { path: packageDir });
  }

  const normalizedName = normalizePackageName(name);
  const packageYmlPath = join(packageDir, FILE_PATTERNS.FORMULA_YML);

  let packageConfig: PackageYml;
  let isNewPackage = false;

  if (await exists(packageYmlPath)) {
    logger.debug("Found existing package.yml for save", { path: packageYmlPath });
    try {
      packageConfig = await parsePackageYml(packageYmlPath);
      console.log(`✓ Found existing package ${packageConfig.name}@${packageConfig.version}`);
    } catch (error) {
      throw new ValidationError(
        ERROR_MESSAGES.PARSE_FORMULA_FAILED.replace("%s", packageYmlPath).replace("%s", String(error))
      );
    }
  } else {
    logger.debug("No package.yml found for save, creating", { dir: packageDir });
    const created = await createPackageYmlInDirectory(packageDir, normalizedName);
    packageConfig = created.config;
    isNewPackage = true;
  }

  const targetVersion = await determineTargetVersion(
    explicitVersion,
    versionType,
    bump,
    isNewPackage ? undefined : packageConfig.version
  );

  const allowOverwrite = force || targetVersion.endsWith(WIP_SUFFIX);

  if (!allowOverwrite) {
    const versionExists = await hasPackageVersion(normalizedName, targetVersion);
    if (versionExists) {
      throw new Error(ERROR_MESSAGES.VERSION_EXISTS.replace("%s", targetVersion));
    }
  }

  const updatedConfig: PackageYml = {
    ...packageConfig,
    name: normalizedName,
    version: targetVersion
  };

  await writePackageYml(packageYmlPath, updatedConfig);

  return {
    fullPath: packageYmlPath,
    config: updatedConfig,
    isNewPackage,
    isRootPackage: false
  };
}
import { DiscoveredFile } from "../../types";
import { discoverAllRootFiles } from "../../utils/package-discovery.js";
import { discoverPlatformFilesUnified } from "./platform-files-discovery.js";

export async function discoverPackageFiles(
  packageName: string,
): Promise<DiscoveredFile[]> {

  const cwd = process.cwd();

  let discoveredFiles: DiscoveredFile[] = [];

  // Discover and include platform files using appropriate logic
  const platformFilesDiscovered = await discoverPlatformFilesUnified(cwd, packageName);
  discoveredFiles.push(...platformFilesDiscovered);

  // Discover all platform root files (AGENTS.md, CLAUDE.md, GEMINI.md, etc.) at project root
  const rootFilesDiscovered = await discoverAllRootFiles(cwd, packageName);
  discoveredFiles.push(...rootFilesDiscovered);

  return discoveredFiles;
}

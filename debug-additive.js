import { discoverFilesForPattern } from './dist/utils/discovery/discovery-core.js';
import { getLocalFormulaDir } from './dist/utils/paths.js';
import { resolvePlatformFileConflicts } from './dist/utils/platform-conflict-resolution.js';
import { resolveRootFileConflicts } from './dist/utils/root-conflict-resolution.js';

async function debugAdditive() {
  const formulaName = 'test-additive-formula';
  const directoryPath = 'test-save';
  const isExplicitPair = true;
  const isDirectory = true;

  const cwd = process.cwd();
  const formulaDir = getLocalFormulaDir(cwd, formulaName);
  const sourceDir = directoryPath.startsWith('/') ? directoryPath : `${cwd}/${directoryPath}`;

  console.log('Debugging additive discovery:');
  console.log('formulaName:', formulaName);
  console.log('directoryPath:', directoryPath);
  console.log('isExplicitPair:', isExplicitPair);
  console.log('isDirectory:', isDirectory);
  console.log('formulaDir:', formulaDir);
  console.log('sourceDir:', sourceDir);

  try {
    const discoveredFiles = await discoverFilesForPattern(formulaDir, formulaName, isExplicitPair, isDirectory, directoryPath, sourceDir);
    console.log('Discovered files:', discoveredFiles.length);
    discoveredFiles.forEach(file => {
      console.log('  -', file.relativePath, '->', file.registryPath);
    });

    // Separate root files from normal files
    const rootFiles = discoveredFiles.filter(f => f.isRootFile);
    const normalFiles = discoveredFiles.filter(f => !f.isRootFile);

    // Resolve root file conflicts separately
    const resolvedRootFiles = await resolveRootFileConflicts(rootFiles, '0.1.0-dev.test');

    // Resolve normal file conflicts
    const resolvedNormalFiles = await resolvePlatformFileConflicts(normalFiles, '0.1.0-dev.test');

    // Combine resolved files
    const resolvedFiles = [...resolvedRootFiles, ...resolvedNormalFiles];
    console.log('After conflict resolution:', resolvedFiles.length);
    resolvedFiles.forEach(file => {
      console.log('  -', file.relativePath, '->', file.registryPath);
    });
  } catch (error) {
    console.error('Error:', error);
  }
}

debugAdditive().catch(console.error);

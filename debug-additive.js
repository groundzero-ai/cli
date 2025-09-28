import { discoverFilesForPattern } from './dist/utils/file-discovery.js';
import { getLocalFormulaDir } from './dist/utils/paths.js';
import { resolveFileConflicts } from './dist/utils/conflict-resolution.js';

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

    const resolvedFiles = await resolveFileConflicts(discoveredFiles, '0.1.0-dev.test');
    console.log('After conflict resolution:', resolvedFiles.length);
    resolvedFiles.forEach(file => {
      console.log('  -', file.relativePath, '->', file.registryPath);
    });
  } catch (error) {
    console.error('Error:', error);
  }
}

debugAdditive().catch(console.error);

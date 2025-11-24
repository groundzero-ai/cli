import assert from 'node:assert/strict';
import { formatSelectionSummary } from '../src/commands/install.js';
import { selectInstallVersionUnified } from '../src/core/install/version-selection.js';

console.log('install-selection tests starting');

async function prefersLocalWhenAvailable() {
  const result = await selectInstallVersionUnified({
    packageName: 'foo',
    constraint: '*',
    mode: 'default',
    localVersions: ['1.0.0'],
    remoteVersions: ['2.0.0']
  });

  assert.equal(result.selectedVersion, '1.0.0', 'should select local version');
  assert.equal(result.resolutionSource, 'local', 'should report local source');
}

async function fallsBackToRemoteWhenLocalMissing() {
  const result = await selectInstallVersionUnified({
    packageName: 'bar',
    constraint: '*',
    mode: 'default',
    localVersions: [],
    remoteVersions: ['2.0.0']
  });

  assert.equal(result.selectedVersion, '2.0.0', 'should fall back to remote version');
  assert.equal(result.resolutionSource, 'remote', 'should report remote source');
}

async function honorsLocalModeWithoutFallback() {
  const result = await selectInstallVersionUnified({
    packageName: 'baz',
    constraint: '*',
    mode: 'local-only',
    localVersions: [],
    remoteVersions: ['5.0.0']
  });

  assert.equal(result.selectedVersion, null, 'local-only mode should not fall back');
  assert.equal(result.resolutionSource, undefined, 'no source when nothing selected');
}

async function scopedPackageSummaryFormatting() {
  const scopedName = '@@hyericlee/nextjs';
  const formatted = formatSelectionSummary('local', scopedName, '0.3.1');
  assert.equal(
    formatted,
    '✓ Selected local @@hyericlee/nextjs@0.3.1',
    'scoped package summary should retain double @ prefix'
  );

  const remoteFormatted = formatSelectionSummary('remote', scopedName, '0.3.1');
  assert.equal(
    remoteFormatted,
    '✓ Selected remote @@hyericlee/nextjs@0.3.1',
    'remote scoped summary should use same formatting'
  );
}

async function runTests() {
  await prefersLocalWhenAvailable();
  await fallsBackToRemoteWhenLocalMissing();
  await honorsLocalModeWithoutFallback();
  await scopedPackageSummaryFormatting();
  console.log('install-selection tests passed');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});


import assert from 'node:assert/strict';
import {
  formatSelectionSummary,
  selectRootVersionWithLocalFallback
} from '../src/commands/install.js';

console.log('install-selection tests starting');

const freshPlan = {
  effectiveRange: '*',
  dependencyState: 'fresh',
  persistDecision: { type: 'none' }
};

function buildSelectionResult(mode, version, overrides = {}) {
  const selection = {
    version,
    isPrerelease: false,
    satisfyingStable: version ? [version] : [],
    satisfyingPrerelease: [],
    availableStable: [],
    availablePrerelease: [],
    reason: version ? 'wildcard' : 'none'
  };

  const sources = {
    localVersions: [],
    remoteVersions: [],
    availableVersions: [],
    remoteStatus: 'skipped',
    warnings: [],
    ...overrides
  };

  return {
    selectedVersion: version,
    selection,
    sources,
    constraint: '*',
    mode
  };
}

async function prefersLocalWhenAvailable() {
  const modes = [];

  const stub = async args => {
    modes.push(args.mode);
    return buildSelectionResult(
      args.mode,
      '1.0.0',
      { localVersions: ['1.0.0'], availableVersions: ['1.0.0'] }
    );
  };

  const result = await selectRootVersionWithLocalFallback({
    packageName: 'foo',
    constraint: '*',
    resolutionMode: 'default',
    canonicalPlan: freshPlan,
    selectVersionImpl: stub
  });

  assert.equal(result.selectedVersion, '1.0.0', 'should select local version');
  assert.deepEqual(modes, ['local-only'], 'should only call local-only once');
}

async function fallsBackToRemoteWhenLocalMissing() {
  const modes = [];

  const stub = async args => {
    modes.push(args.mode);
    if (args.mode === 'local-only') {
      return buildSelectionResult(
        args.mode,
        null,
        { localVersions: [], availableVersions: [] }
      );
    }
    return buildSelectionResult(
      args.mode,
      '2.0.0',
      {
        remoteStatus: 'success',
        remoteVersions: ['2.0.0'],
        availableVersions: ['2.0.0'],
        localVersions: []
      }
    );
  };

  const result = await selectRootVersionWithLocalFallback({
    packageName: 'bar',
    constraint: '*',
    resolutionMode: 'default',
    canonicalPlan: freshPlan,
    selectVersionImpl: stub
  });

  assert.equal(result.selectedVersion, '2.0.0', 'should fall back to remote version');
  assert.deepEqual(
    modes,
    ['local-only', 'default'],
    'should call local-only first, then default fallback'
  );
}

async function fallsBackWithCliSpec() {
  const modes = [];

  const stub = async args => {
    modes.push(args.mode);
    if (args.mode === 'local-only') {
      return buildSelectionResult(
        args.mode,
        null,
        { localVersions: [], availableVersions: [] }
      );
    }
    return buildSelectionResult(
      args.mode,
      '4.2.0',
      {
        remoteStatus: 'success',
        remoteVersions: ['4.2.0'],
        availableVersions: ['4.2.0'],
        localVersions: []
      }
    );
  };

  const result = await selectRootVersionWithLocalFallback({
    packageName: 'cli-spec',
    constraint: '^4.2.0',
    resolutionMode: 'default',
    canonicalPlan: freshPlan,
    cliVersion: '^4.2.0',
    selectVersionImpl: stub
  });

  assert.equal(result.selectedVersion, '4.2.0', 'should fall back to remote version for CLI spec');
  assert.deepEqual(
    modes,
    ['local-only', 'default'],
    'CLI spec should still run local-only first then fallback'
  );
}

async function honorsLocalModeWithoutFallback() {
  const modes = [];

  const stub = async args => {
    modes.push(args.mode);
    return buildSelectionResult(
      args.mode,
      null,
      { localVersions: [], availableVersions: [] }
    );
  };

  const result = await selectRootVersionWithLocalFallback({
    packageName: 'baz',
    constraint: '*',
    resolutionMode: 'local-only',
    canonicalPlan: freshPlan,
    selectVersionImpl: stub
  });

  assert.equal(result.selectedVersion, null, 'local-only mode should not fall back');
  assert.deepEqual(modes, ['local-only'], 'local-only mode should only call once');
}

async function skipsFallbackForExistingDependency() {
  const modes = [];

  const stub = async args => {
    modes.push(args.mode);
    return buildSelectionResult(
      args.mode,
      '3.0.0',
      {
        remoteStatus: 'success',
        remoteVersions: ['3.0.0'],
        availableVersions: ['3.0.0']
      }
    );
  };

  const existingPlan = {
    ...freshPlan,
    dependencyState: 'existing'
  };

  const result = await selectRootVersionWithLocalFallback({
    packageName: 'qux',
    constraint: '^3.0.0',
    resolutionMode: 'default',
    canonicalPlan: existingPlan,
    selectVersionImpl: stub
  });

  assert.equal(result.selectedVersion, '3.0.0', 'existing dependency should resolve immediately');
  assert.deepEqual(modes, ['default'], 'existing dependency should not do local-first pass');
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
  await fallsBackWithCliSpec();
  await honorsLocalModeWithoutFallback();
  await skipsFallbackForExistingDependency();
  await scopedPackageSummaryFormatting();
  console.log('install-selection tests passed');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});


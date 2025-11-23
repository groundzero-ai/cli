import {
  selectVersionWithWipPolicy,
  hasExplicitPrereleaseIntent
} from '../src/utils/version-ranges.js';

function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected} but received ${actual}`);
  }
}

function expectTrue(value: boolean, label: string): void {
  if (!value) {
    throw new Error(`${label} expected truthy value`);
  }
}

const versions = ['1.0.0', '1.0.1-wip.abc', '1.1.0'];
const stableSelection = selectVersionWithWipPolicy(versions, '^1.0.0');
expectEqual(stableSelection.version, '1.1.0', 'stable selection version');
expectEqual(stableSelection.isPrerelease, false, 'stable selection prerelease flag');

const wildcardSelection = selectVersionWithWipPolicy(
  ['0.1.0-wip.local'],
  '*'
);
expectEqual(wildcardSelection.version, '0.1.0-wip.local', 'wildcard selection version');
expectEqual(wildcardSelection.isPrerelease, true, 'wildcard selection prerelease flag');

const prereleaseIntentSelection = selectVersionWithWipPolicy(
  ['2.0.0', '2.1.0-wip.dev'],
  '^2.1.0-0',
  { explicitPrereleaseIntent: true }
);
expectEqual(
  prereleaseIntentSelection.version,
  '2.1.0-wip.dev',
  'prerelease intent selection version'
);
expectEqual(
  prereleaseIntentSelection.isPrerelease,
  true,
  'prerelease intent selection flag'
);

expectTrue(hasExplicitPrereleaseIntent('^1.0.0-0'), 'explicit prerelease intent detection');
expectTrue(!hasExplicitPrereleaseIntent('*'), 'implicit prerelease absence');

console.log('version-selection tests passed');


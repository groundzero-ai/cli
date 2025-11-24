import assert from 'node:assert/strict';
import { computeWipVersion, computePackTargetVersion } from '../src/core/save/save-versioning.js';

const fixedDate = new Date('2024-11-23T12:34:56Z');
const testWorkspacePath = '/test/workspace';

// First save with no index: WIP derived directly from package.yml.version
const wipFromStable = computeWipVersion('1.2.3', undefined, testWorkspacePath, { now: fixedDate });
console.log('wipFromStable', wipFromStable);
assert.equal(wipFromStable.stable, '1.2.3');
assert.equal(wipFromStable.effectiveStable, '1.2.3');
assert.ok(wipFromStable.wipVersion.startsWith('1.2.3-'));
assert.equal(wipFromStable.reset, false);
assert.equal(wipFromStable.shouldBumpPackageYml, false);

// Continuing WIP on the same line: last workspace version is a WIP prerelease
const continuingWip = computeWipVersion(
  '1.2.3',
  '1.2.3-000000.abc',
  testWorkspacePath,
  { now: new Date('2024-11-23T12:35:00Z') }
);
console.log('continuingWip', continuingWip);
assert.equal(continuingWip.stable, '1.2.3');
assert.equal(continuingWip.effectiveStable, '1.2.3');
assert.ok(continuingWip.wipVersion.startsWith('1.2.3-'));
assert.equal(continuingWip.reset, false);
assert.equal(continuingWip.shouldBumpPackageYml, false);

// After a packed/installed stable S, start WIP from patch(S) and request auto-bump
const wipAfterStable = computeWipVersion(
  '1.2.3',
  '1.2.3', // last workspace version is a non-prerelease stable
  testWorkspacePath,
  { now: fixedDate }
);
console.log('wipAfterStable', wipAfterStable);
assert.equal(wipAfterStable.stable, '1.2.3');
assert.equal(wipAfterStable.effectiveStable, '1.2.4');
assert.ok(wipAfterStable.wipVersion.startsWith('1.2.4-'));
assert.equal(wipAfterStable.shouldBumpPackageYml, true);
assert.equal(wipAfterStable.nextStable, '1.2.4');

// Changing the version line in package.yml should trigger a reset, not a bump
const resetWip = computeWipVersion(
  '3.0.0',
  '2.0.0-zzzzzz.abc',
  testWorkspacePath,
  { now: fixedDate }
);
console.log('resetWip', resetWip);
assert.equal(resetWip.stable, '3.0.0');
assert.equal(resetWip.effectiveStable, '3.0.0');
assert.ok(resetWip.wipVersion.startsWith('3.0.0-'));
assert.equal(resetWip.reset, true);
assert.equal(resetWip.shouldBumpPackageYml, false);

// Pack target computation still promotes the current stable and suggests the next patch
const packDefault = computePackTargetVersion('1.2.3', '1.2.3-zzzzzz.abc');
console.log('packDefault', packDefault);
assert.equal(packDefault.targetVersion, '1.2.3');
assert.equal(packDefault.nextStable, '1.2.4');

console.log('save-pack-versioning tests passed');


import assert from 'node:assert/strict';
import { computeWipVersion, computePackTargetVersion } from '../src/core/save/save-versioning.js';

const fixedDate = new Date('2024-11-23T12:34:56Z');

const wipFromStable = computeWipVersion('1.2.3', undefined, 'abcd1234', { now: fixedDate });
assert.equal(wipFromStable.stable, '1.2.3');
assert.ok(wipFromStable.wipVersion.startsWith('1.2.3-wip.'));
assert.equal(wipFromStable.reset, false);

const continuingWip = computeWipVersion(
  '1.2.3',
  '1.2.3-wip.00000000.abcd1234',
  'abcd1234',
  { now: new Date('2024-11-23T12:35:00Z') }
);
assert.equal(continuingWip.reset, false);

const resetWip = computeWipVersion(
  '3.0.0',
  '2.0.0-wip.zzzzzzzz.abcd1234',
  'abcd1234',
  { now: fixedDate }
);
assert.equal(resetWip.stable, '3.0.0');
assert.equal(resetWip.reset, true);

const packDefault = computePackTargetVersion('1.2.3', '1.2.3-wip.zzzzzzzz.abcd1234');
assert.equal(packDefault.targetVersion, '1.2.3');
assert.equal(packDefault.nextStable, '1.2.4');

console.log('save-pack-versioning tests passed');


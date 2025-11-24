import assert from 'node:assert/strict';
import { getLatestStableVersion } from '../src/utils/package-versioning.js';

const mixOfVersions = ['1.0.0', '1.2.0-dev.abc', '2.0.0', '1.9.9', '2.0.1-beta.1'];
assert.equal(getLatestStableVersion(mixOfVersions), '2.0.0');

const unorderedWithStable = ['0.5.0', '1.1.0', '1.0.5', '1.2.0'];
assert.equal(getLatestStableVersion(unorderedWithStable), '1.2.0');

const prereleaseOnly = ['2.0.0-alpha', '2.0.0-beta.1'];
assert.equal(getLatestStableVersion(prereleaseOnly), null);

console.log('push-stable-selection tests passed');


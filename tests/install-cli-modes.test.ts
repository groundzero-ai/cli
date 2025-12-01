import assert from 'node:assert/strict';
import { determineResolutionMode } from '../src/core/install/install-pipeline.js';
import { validateResolutionFlags } from '../src/commands/install.js';

const defaultMode = determineResolutionMode({});
assert.equal(defaultMode, 'default');

const remoteMode = determineResolutionMode({ remote: true });
assert.equal(remoteMode, 'remote-primary');

const localMode = determineResolutionMode({ local: true });
assert.equal(localMode, 'local-only');

const presetMode = determineResolutionMode({ resolutionMode: 'remote-primary', local: true });
assert.equal(presetMode, 'remote-primary');

assert.throws(
  () => validateResolutionFlags({ remote: true, local: true }),
  /--remote and --local cannot be used together/
);

validateResolutionFlags({ remote: true });
validateResolutionFlags({ local: true });

console.log('install-cli-modes tests passed');


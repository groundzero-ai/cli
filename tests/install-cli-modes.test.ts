import assert from 'node:assert/strict';
import {
  determineResolutionMode,
  selectInstallScenario,
  validateResolutionFlags,
} from '../src/commands/install.js';

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

const forceRemoteScenario = selectInstallScenario('remote-primary', true);
assert.equal(forceRemoteScenario, 'force-remote');

const localOnlyScenario = selectInstallScenario('local-only', false);
assert.equal(localOnlyScenario, 'local-primary');

const defaultLocalScenario = selectInstallScenario('default', true);
assert.equal(defaultLocalScenario, 'local-primary');

const defaultRemoteScenario = selectInstallScenario('default', false);
assert.equal(defaultRemoteScenario, 'remote-primary');

console.log('install-cli-modes tests passed');


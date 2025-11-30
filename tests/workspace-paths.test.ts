import assert from 'node:assert/strict';
import { join } from 'path';

import { isAllowedRegistryPath } from '../src/utils/registry-entry-filter.js';
import { resolveTargetDirectory, resolveTargetFilePath } from '../src/utils/platform-mapper.js';
import { DIR_PATTERNS } from '../src/constants/index.js';

// isAllowedRegistryPath should accept arbitrary workspace paths
assert.equal(isAllowedRegistryPath('docs/getting-started.md'), true);
assert.equal(isAllowedRegistryPath('src/features/foo/bar.md'), true);

// Root and YAML override paths remain blocked
assert.equal(isAllowedRegistryPath('AGENTS.md'), false);
assert.equal(isAllowedRegistryPath('rules/agent.cursor.yml'), false);

// Resolve target directory/file for generic workspace paths should preserve structure
const packageDir = '/tmp/package-example';
const genericDir = resolveTargetDirectory(packageDir, 'guides/intro.md');
assert.equal(genericDir, packageDir);
const genericPath = resolveTargetFilePath(genericDir, 'guides/intro.md');
assert.equal(genericPath, join(packageDir, 'guides/intro.md'));

// Universal subdir paths still map under .openpackage
const universalDir = resolveTargetDirectory(packageDir, 'rules/example.md');
assert.equal(universalDir, join(packageDir, DIR_PATTERNS.OPENPACKAGE));
const universalPath = resolveTargetFilePath(universalDir, 'rules/example.md');
assert.equal(universalPath, join(universalDir, 'rules/example.md'));

console.log('workspace path handling tests passed');



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
// YAML override paths with canonical .openpackage/ prefix should be blocked
assert.equal(isAllowedRegistryPath('.openpackage/rules/agent.cursor.yml'), false);
// Legacy paths without .openpackage/ prefix are allowed (not recognized as universal subdir)
assert.equal(isAllowedRegistryPath('rules/agent.cursor.yml'), true);

// Resolve target directory/file for generic workspace paths should preserve structure
const packageDir = '/tmp/package-example';
const genericDir = resolveTargetDirectory(packageDir, 'guides/intro.md');
assert.equal(genericDir, join(packageDir, 'guides'));
const genericPath = resolveTargetFilePath(genericDir, 'guides/intro.md');
assert.equal(genericPath, join(packageDir, 'guides', 'intro.md'));

// Universal subdir paths with .openpackage prefix preserve the full structure
const universalDir = resolveTargetDirectory(packageDir, '.openpackage/rules/example.md');
assert.equal(universalDir, join(packageDir, DIR_PATTERNS.OPENPACKAGE, 'rules'));
const universalPath = resolveTargetFilePath(universalDir, '.openpackage/rules/example.md');
assert.equal(universalPath, join(universalDir, 'example.md'));

console.log('workspace path handling tests passed');



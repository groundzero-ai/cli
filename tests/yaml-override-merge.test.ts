import assert from 'node:assert/strict';
import { mergePlatformYamlOverride } from '../src/utils/platform-yaml-merge.js';
import type { PackageFile } from '../src/types/index.js';

// Test: YAML override merge with canonical .openpackage prefix path layout
// This test verifies that the installer correctly merges YAML override files
// stored at .openpackage/<subdir>/<base>.<platform>.yml into universal markdown content.

const universalContent = `---
description: "Universal description"
model: "gpt-4"
---

# Universal Agent

This is the universal agent content.
`;

const opencodeFrontmatterOverride = `model: "claude-3-opus"
temperature: 0.7
`;

// Package files with canonical .openpackage/ prefix layout
const packageFilesCanonical: PackageFile[] = [
  {
    path: '.openpackage/agents/yaml-test.md',
    content: universalContent,
    encoding: 'utf8'
  },
  {
    path: '.openpackage/agents/yaml-test.opencode.yml',
    content: opencodeFrontmatterOverride,
    encoding: 'utf8'
  }
];

// Test 1: Merge should find override with canonical .openpackage/ prefix
const mergedContent = mergePlatformYamlOverride(
  universalContent,
  'opencode',
  'agents',
  'yaml-test.md',
  packageFilesCanonical
);

// Verify that the merged content contains the override values
assert.ok(
  mergedContent.includes('claude-3-opus'),
  'Merged content should include opencode-specific model override'
);
assert.ok(
  mergedContent.includes('temperature'),
  'Merged content should include temperature from override'
);
assert.ok(
  mergedContent.includes('Universal description'),
  'Merged content should preserve universal description'
);
assert.ok(
  mergedContent.includes('# Universal Agent'),
  'Merged content should preserve markdown body'
);

console.log('✓ YAML override merge with canonical .openpackage/ prefix works correctly');

// Test 2: Merge should NOT find override with legacy path (without .openpackage/ prefix)
const packageFilesLegacy: PackageFile[] = [
  {
    path: 'agents/yaml-test.md',
    content: universalContent,
    encoding: 'utf8'
  },
  {
    path: 'agents/yaml-test.opencode.yml',  // Legacy path without .openpackage/
    content: opencodeFrontmatterOverride,
    encoding: 'utf8'
  }
];

const mergedContentLegacy = mergePlatformYamlOverride(
  universalContent,
  'opencode',
  'agents',
  'yaml-test.md',
  packageFilesLegacy
);

// Should return original content since override is not found at canonical path
assert.strictEqual(
  mergedContentLegacy,
  universalContent,
  'Merge should return original content when override is at legacy path (not canonical)'
);

console.log('✓ YAML override merge correctly ignores legacy paths without .openpackage/ prefix');

// Test 3: Merge should work for other platforms (cursor, claude, etc.)
const cursorFrontmatterOverride = `model: "gpt-4-turbo"
maxTokens: 8000
`;

const packageFilesMultiPlatform: PackageFile[] = [
  {
    path: '.openpackage/agents/yaml-test.md',
    content: universalContent,
    encoding: 'utf8'
  },
  {
    path: '.openpackage/agents/yaml-test.opencode.yml',
    content: opencodeFrontmatterOverride,
    encoding: 'utf8'
  },
  {
    path: '.openpackage/agents/yaml-test.cursor.yml',
    content: cursorFrontmatterOverride,
    encoding: 'utf8'
  }
];

const mergedForCursor = mergePlatformYamlOverride(
  universalContent,
  'cursor',
  'agents',
  'yaml-test.md',
  packageFilesMultiPlatform
);

assert.ok(
  mergedForCursor.includes('gpt-4-turbo'),
  'Cursor merge should include cursor-specific model'
);
assert.ok(
  mergedForCursor.includes('maxTokens'),
  'Cursor merge should include maxTokens from cursor override'
);
assert.ok(
  !mergedForCursor.includes('temperature'),
  'Cursor merge should NOT include opencode-specific temperature'
);

console.log('✓ YAML override merge works correctly for multiple platforms');

// Test 4: Non-markdown files should be returned unchanged
const nonMarkdownContent = 'some non-markdown content';
const mergedNonMd = mergePlatformYamlOverride(
  nonMarkdownContent,
  'opencode',
  'agents',
  'yaml-test.txt',
  packageFilesCanonical
);

assert.strictEqual(
  mergedNonMd,
  nonMarkdownContent,
  'Non-markdown files should be returned unchanged'
);

console.log('✓ Non-markdown files are returned unchanged');

console.log('\n✅ All YAML override merge tests passed!');


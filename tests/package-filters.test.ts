import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPackageFileFilter } from '../src/utils/package-filters.js';
import { readPackageFilesForRegistry } from '../src/utils/package-copy.js';
import { ensurePackageWithYml, createWorkspacePackageYml } from '../src/utils/package-management.js';
import { parsePackageYml } from '../src/utils/package-yml.js';

async function runUnitTests(): Promise<void> {
  const filter = createPackageFileFilter({
    include: ['.openpackage/agents/**', 'README.md'],
    exclude: ['**/*.tmp']
  });

  assert.equal(filter('.openpackage/agents/intro.md'), true);
  assert.equal(filter('.openpackage/agents/notes.tmp'), false, 'exclude should remove tmp files');
  assert.equal(filter('README.md'), true, 'explicit include should allow README');
  assert.equal(
    filter('.openpackage/skills/skill.md'),
    false,
    'paths outside include set should be rejected'
  );
}

async function runIntegrationTest(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'package-filters-'));

  try {
    await mkdir(join(tempDir, '.openpackage/agents'), { recursive: true });
    await mkdir(join(tempDir, '.openpackage/skills'), { recursive: true });

    await writeFile(
      join(tempDir, 'package.yml'),
      [
        'name: filters-test',
        'version: "1.0.0"',
        'include:',
        '  - .openpackage/agents/**',
        '  - README.md',
        'exclude:',
        '  - "**/*.tmp"',
        ''
      ].join('\n'),
      'utf8'
    );
    await writeFile(join(tempDir, '.openpackage/agents/keep.md'), 'keep', 'utf8');
    await writeFile(join(tempDir, '.openpackage/agents/skip.tmp'), 'tmp', 'utf8');
    await writeFile(join(tempDir, '.openpackage/skills/ignore.md'), 'ignore', 'utf8');
    await writeFile(join(tempDir, 'README.md'), '# Filters', 'utf8');
    await writeFile(join(tempDir, 'package.index.yml'), 'workspace:\n  version: 1.0.0', 'utf8');

    const files = await readPackageFilesForRegistry(tempDir);
    const paths = files.map(file => file.path).sort();
    assert.deepEqual(
      paths,
      ['.openpackage/agents/keep.md', '.openpackage/skills/ignore.md', 'README.md', 'package.yml']
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runDefaultFilteringTest(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'package-filters-default-'));

  try {
    await mkdir(join(tempDir, '.openpackage/agents'), { recursive: true });

    await writeFile(
      join(tempDir, 'package.yml'),
      ['name: defaults-test', 'version: "1.0.0"', ''].join('\n'),
      'utf8'
    );
    await writeFile(join(tempDir, '.openpackage/agents/keep.md'), 'keep', 'utf8');
    await writeFile(join(tempDir, 'README.md'), '# Defaults', 'utf8');

    const files = await readPackageFilesForRegistry(tempDir);
    const paths = files.map(file => file.path).sort();
    assert.deepEqual(paths, ['.openpackage/agents/keep.md', 'package.yml']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runNestedManifestTest(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'package-filters-nested-'));

  try {
    await mkdir(join(tempDir, '.openpackage/agents'), { recursive: true });

    await writeFile(
      join(tempDir, '.openpackage/package.yml'),
      ['name: nested-test', 'version: "1.0.0"', ''].join('\n'),
      'utf8'
    );
    await writeFile(join(tempDir, '.openpackage/agents/keep.md'), 'keep', 'utf8');

    const files = await readPackageFilesForRegistry(tempDir);
    const paths = files.map(file => file.path).sort();
    assert.deepEqual(paths, ['.openpackage/agents/keep.md', '.openpackage/package.yml']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runEnsurePackageDefaultsTest(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'package-ensure-default-'));

  try {
    const result = await ensurePackageWithYml(tempDir, 'nested-test', { defaultVersion: '0.1.0' });
    assert.deepEqual(result.packageConfig.include, ['**']);

    const nestedConfig = await parsePackageYml(result.packageYmlPath);
    assert.deepEqual(nestedConfig.include, ['**']);

    await createWorkspacePackageYml(tempDir);
    const rootConfig = await parsePackageYml(join(tempDir, '.openpackage', 'package.yml'));
    assert.equal(rootConfig.include, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runRootExcludesNestedPackagesTest(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'package-filters-nested-exclude-'));

  try {
    // Root package manifest + content
    await mkdir(join(tempDir, '.openpackage', 'commands'), { recursive: true });
    await writeFile(
      join(tempDir, '.openpackage', 'package.yml'),
      ['name: nested-exclude-root', 'version: "1.0.0"', 'include:', '  - "**"', ''].join('\n'),
      'utf8'
    );
    await writeFile(
      join(tempDir, '.openpackage', 'commands', 'root.md'),
      '# root',
      'utf8'
    );

    // Nested package inside .openpackage/packages/<child>/
    const nestedPackageDir = join(
      tempDir,
      '.openpackage',
      'packages',
      'child',
      '.openpackage',
      'commands'
    );
    await mkdir(nestedPackageDir, { recursive: true });
    await writeFile(
      join(tempDir, '.openpackage', 'packages', 'child', '.openpackage', 'package.yml'),
      ['name: child', 'version: "0.1.0"', 'include:', '  - "**"', ''].join('\n'),
      'utf8'
    );
    await writeFile(join(nestedPackageDir, 'nested.md'), '# nested', 'utf8');

    const files = await readPackageFilesForRegistry(tempDir);
    const paths = files.map(file => file.path);

    assert(paths.includes('.openpackage/commands/root.md'));
    assert(
      paths.every(path => !path.startsWith('.openpackage/packages/child/')),
      'root payload should not include nested package files'
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await runUnitTests();
await runIntegrationTest();
await runDefaultFilteringTest();
await runNestedManifestTest();
await runEnsurePackageDefaultsTest();
await runRootExcludesNestedPackagesTest();

console.log('package-filters tests passed');


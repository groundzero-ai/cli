import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPackageFileFilter } from '../src/utils/package-filters.js';
import { readPackageFilesForRegistry } from '../src/utils/package-copy.js';

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
    assert.deepEqual(paths, ['.openpackage/agents/keep.md', 'README.md']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await runUnitTests();
await runIntegrationTest();

console.log('package-filters tests passed');


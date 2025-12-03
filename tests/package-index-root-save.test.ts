import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSavePipeline } from '../src/core/save/save-pipeline.js';
import { readPackageIndex } from '../src/utils/package-index-yml.js';

async function runRootSaveIndexTest(): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), 'opkg-root-save-index-'));

  try {
    // Create a minimal root package with a universal commands file
    await mkdir(join(tempDir, '.openpackage', 'commands'), { recursive: true });
    await writeFile(
      join(tempDir, '.openpackage', 'package.yml'),
      ['name: root-save-index-test', 'version: "1.0.0"', ''].join('\n'),
      'utf8'
    );
    await writeFile(
      join(tempDir, '.openpackage', 'commands', 'example.md'),
      '# Example command',
      'utf8'
    );

    // Ensure at least one platform is detectable (Cursor)
    await mkdir(join(tempDir, '.cursor'), { recursive: true });

    process.chdir(tempDir);

    const result = await runSavePipeline(undefined, {
      mode: 'wip',
      force: true
    });

    assert.equal(result.success, true, 'save pipeline should succeed');

    let indexRecord = await readPackageIndex(tempDir, 'root-save-index-test', 'root');
    assert.ok(indexRecord, 'package.index.yml should be created for root package (first save)');

    let files = indexRecord!.files;
    assert.notEqual(
      Object.keys(files).length,
      0,
      'package.index.yml.files should not be empty after first save with universal content'
    );

    const key = '.openpackage/commands/example.md';
    assert.ok(
      Array.isArray(files[key]) && files[key].length > 0,
      'package.index.yml should record mapping for .openpackage/commands/example.md after first save'
    );

    // Run a second save to ensure existing mappings are preserved / updated, not cleared
    const secondResult = await runSavePipeline(undefined, {
      mode: 'wip',
      force: true
    });
    assert.equal(secondResult.success, true, 'second save pipeline should also succeed');

    indexRecord = await readPackageIndex(tempDir, 'root-save-index-test', 'root');
    assert.ok(indexRecord, 'package.index.yml should still exist after second save');

    files = indexRecord!.files;
    assert.notEqual(
      Object.keys(files).length,
      0,
      'package.index.yml.files should not be emptied after second save with universal content'
    );
    assert.ok(
      Array.isArray(files[key]) && files[key].length > 0,
      'package.index.yml should still record mapping for .openpackage/commands/example.md after second save'
    );

    console.log('package-index-root-save tests passed');
  } finally {
    process.chdir(originalCwd);
    await rm(tempDir, { recursive: true, force: true });
  }
}

await runRootSaveIndexTest();



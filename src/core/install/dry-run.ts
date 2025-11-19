import type { InstallOptions, CommandResult } from '../../types/index.js';
import type { ResolvedFormula } from '../dependency-resolver.js';
import { CONFLICT_RESOLUTION } from '../../constants/index.js';
import { installAiFiles } from '../../utils/install-orchestrator.js';

/**
 * Handle dry run mode for formula installation
 */
export async function handleDryRunMode(
  resolvedFormulas: ResolvedFormula[],
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  formulaYmlExists: boolean
): Promise<CommandResult> {
  console.log(`✓ Dry run - showing what would be installed:\n`);

  const mainFormula = resolvedFormulas.find(f => f.isRoot);
  if (mainFormula) {
    console.log(`Formula: ${mainFormula.name} v${mainFormula.version}`);
    if (mainFormula.formula.metadata.description) {
      console.log(`Description: ${mainFormula.formula.metadata.description}`);
    }
    console.log('');
  }

  // Show what would be installed to ai
  for (const resolved of resolvedFormulas) {
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.SKIPPED) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (user would decline overwrite)`);
      continue;
    }

    if (resolved.conflictResolution === CONFLICT_RESOLUTION.KEPT) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }

    const dryRunResult = await installAiFiles(resolved.name, targetDir, options, resolved.version, true);

    if (dryRunResult.skipped) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }

    console.log(`✓ Would install to ai${targetDir !== '.' ? '/' + targetDir : ''}: ${dryRunResult.installedCount} files`);

    if (dryRunResult.overwritten) {
      console.log(`  ⚠️  Would overwrite existing directory`);
    }
  }

  // Show formula.yml update
  if (formulaYmlExists) {
    console.log(`\n✓ Would add to .openpackage/formula.yml: ${formulaName}@${resolvedFormulas.find(f => f.isRoot)?.version}`);
  } else {
    console.log('\nNo .openpackage/formula.yml found - skipping dependency addition');
  }

  return {
    success: true,
    data: {
      dryRun: true,
      resolvedFormulas,
      totalFormulas: resolvedFormulas.length
    }
  };
}

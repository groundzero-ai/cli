import type { PackageRemoteResolutionOutcome } from './types.js';
import { extractRemoteErrorReason } from '../../utils/error-reasons.js';

export function formatSelectionSummary(
  source: 'local' | 'remote',
  packageName: string,
  version: string
): string {
  const packageSpecifier = packageName.startsWith('@') ? packageName : `@${packageName}`;
  return `✓ Selected ${source} ${packageSpecifier}@${version}`;
}

export function displayInstallationSummary(
  totalInstalled: number,
  totalSkipped: number,
  totalPackages: number,
  results: Array<{ name: string; success: boolean; error?: string }>
): void {
  console.log(`\n✓ Installation Summary:`);
  console.log(`✓ Successfully installed: ${totalInstalled}/${totalPackages} packages`);

  if (totalSkipped > 0) {
    console.log(`❌ Failed to install: ${totalSkipped} packages`);
    console.log('\nFailed packages:');
    results.filter(r => !r.success).forEach(result => {
      console.log(`  • ${result.name}: ${result.error}`);
    });
  }
}

export function displayInstallationResults(
  packageName: string,
  resolvedPackages: any[],
  platformResult: { platforms: string[]; created: string[] },
  options: any,
  mainPackage?: any,
  allAddedFiles?: string[],
  allUpdatedFiles?: string[],
  rootFileResults?: { installed: string[]; updated: string[]; skipped: string[] },
  missingPackages?: string[],
  missingPackageOutcomes?: Record<string, PackageRemoteResolutionOutcome>
): void {
  let summaryText = `✓ Installed ${packageName}`;
  if (mainPackage) {
    summaryText += `@${mainPackage.version}`;
  }

  console.log(`${summaryText}`);

  const dependencyPackages = resolvedPackages.filter(f => !f.isRoot);
  if (dependencyPackages.length > 0) {
    console.log(`✓ Installed dependencies: ${dependencyPackages.length}`);
    for (const dep of dependencyPackages) {
      const packageSpecifier =
        typeof dep.name === 'string' && dep.name.startsWith('@')
          ? dep.name
          : `@${dep.name}`;
      console.log(`   ├── ${packageSpecifier}@${dep.version}`);
    }
  }
  console.log(`✓ Total packages processed: ${resolvedPackages.length}`);

  if (allAddedFiles && allAddedFiles.length > 0) {
    console.log(`✓ Added files: ${allAddedFiles.length}`);
    const sortedFiles = [...allAddedFiles].sort((a, b) => a.localeCompare(b));
    for (const file of sortedFiles) {
      console.log(`   ├── ${file}`);
    }
  }

  if (allUpdatedFiles && allUpdatedFiles.length > 0) {
    console.log(`✓ Updated files: ${allUpdatedFiles.length}`);
    const sortedFiles = [...allUpdatedFiles].sort((a, b) => a.localeCompare(b));
    for (const file of sortedFiles) {
      console.log(`   ├── ${file}`);
    }
  }

  if (rootFileResults) {
    const totalRootFiles = rootFileResults.installed.length + rootFileResults.updated.length;
    if (totalRootFiles > 0) {
      console.log(`✓ Root files: ${totalRootFiles} file(s)`);

      if (rootFileResults.installed.length > 0) {
        const sortedInstalled = [...rootFileResults.installed].sort((a, b) => a.localeCompare(b));
        for (const file of sortedInstalled) {
          console.log(`   ├── ${file} (created)`);
        }
      }

      if (rootFileResults.updated.length > 0) {
        const sortedUpdated = [...rootFileResults.updated].sort((a, b) => a.localeCompare(b));
        for (const file of sortedUpdated) {
          console.log(`   ├── ${file} (updated)`);
        }
      }
    }
  }

  if (platformResult.created.length > 0) {
    console.log(`✓ Created platform directories: ${platformResult.created.join(', ')}`);
  }

  if (missingPackages && missingPackages.length > 0) {
    console.log(`\n⚠️  Missing dependencies detected:`);
    for (const missing of missingPackages) {
      const reasonLabel = formatMissingDependencyReason(missingPackageOutcomes?.[missing]);
      console.log(`   • ${missing} (${reasonLabel})`);
    }
    console.log(`\n💡 To resolve missing dependencies:`);
    console.log(`   • Create locally: opkg init && opkg save`);
    console.log(`   • Pull from remote: opkg pull ${missingPackages.join(' ')}`);
    console.log(`   • Remove from package.yml`);
    console.log('');
  }
}

function formatMissingDependencyReason(outcome?: PackageRemoteResolutionOutcome): string {
  if (!outcome) {
    return 'not found in registry';
  }

  switch (outcome.reason) {
    case 'not-found':
      return 'not found in remote registry';
    case 'access-denied':
      return 'access denied';
    case 'network':
      return 'network error';
    case 'integrity':
      return 'integrity check failed';
    default:
      return extractRemoteErrorReason(outcome.message || 'unknown error');
  }
}


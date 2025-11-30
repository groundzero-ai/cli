import * as semver from 'semver';

import type { PackageYml } from '../../types/index.js';
import { exists } from '../../utils/fs.js';
import { getLocalPackageYmlPath } from '../../utils/paths.js';
import { parsePackageYml } from '../../utils/package-yml.js';
import { createCaretRange, parseVersionRange } from '../../utils/version-ranges.js';
import { arePackageNamesEquivalent } from '../../utils/package-name.js';

export type DependencyTarget = 'packages' | 'dev-packages';

export type PersistDecision =
  | { type: 'none' }
  | { type: 'explicit'; target: DependencyTarget; range: string }
  | { type: 'derive'; target: DependencyTarget; mode: 'caret-or-exact' };

export interface CanonicalInstallPlan {
  effectiveRange: string;
  dependencyState: 'fresh' | 'existing';
  canonicalRange?: string;
  canonicalTarget?: DependencyTarget;
  persistDecision: PersistDecision;
  compatibilityMessage?: string;
}

export interface CanonicalPlanArgs {
  cwd: string;
  packageName: string;
  cliSpec?: string;
  devFlag: boolean;
}

interface ParsedConstraint {
  resolverRange: string;
  displayRange: string;
}

export async function determineCanonicalInstallPlan(args: CanonicalPlanArgs): Promise<CanonicalInstallPlan> {
  const normalizedCliSpec = args.cliSpec?.trim() || undefined;
  const existing = await findCanonicalDependency(args.cwd, args.packageName);

  const target: DependencyTarget = args.devFlag ? 'dev-packages' : 'packages';

  if (existing) {
    const canonicalConstraint = parseConstraintOrThrow('package', existing.range, args.packageName);

    if (normalizedCliSpec) {
      const cliConstraint = parseConstraintOrThrow('cli', normalizedCliSpec, args.packageName);
      if (!isRangeSubset(cliConstraint.resolverRange, canonicalConstraint.resolverRange)) {
        throw buildCanonicalConflictError(args.packageName, cliConstraint.displayRange, existing.range);
      }

      return {
        effectiveRange: canonicalConstraint.resolverRange,
        dependencyState: 'existing',
        canonicalRange: existing.range,
        canonicalTarget: existing.target,
        persistDecision: { type: 'none' },
        compatibilityMessage: `Using version range from package.yml (${existing.range}); CLI spec '${cliConstraint.displayRange}' is compatible.`
      };
    }

    return {
      effectiveRange: canonicalConstraint.resolverRange,
      dependencyState: 'existing',
      canonicalRange: existing.range,
      canonicalTarget: existing.target,
      persistDecision: { type: 'none' }
    };
  }

  if (normalizedCliSpec) {
    const cliConstraint = parseConstraintOrThrow('cli', normalizedCliSpec, args.packageName);
    return {
      effectiveRange: cliConstraint.resolverRange,
      dependencyState: 'fresh',
      persistDecision: {
        type: 'explicit',
        target,
        range: cliConstraint.displayRange
      }
    };
  }

  return {
    effectiveRange: '*',
    dependencyState: 'fresh',
    persistDecision: {
      type: 'derive',
      target,
      mode: 'caret-or-exact'
    }
  };
}

export async function findCanonicalDependency(
  cwd: string,
  packageName: string
): Promise<{ range: string; target: DependencyTarget } | null> {
  const packageYmlPath = getLocalPackageYmlPath(cwd);
  if (!(await exists(packageYmlPath))) {
    return null;
  }

  try {
    const config = await parsePackageYml(packageYmlPath);
    const match =
      locateDependencyInArray(config.packages, packageName, 'packages') ||
      locateDependencyInArray(config['dev-packages'], packageName, 'dev-packages');
    return match;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${packageYmlPath}: ${detail}`);
  }
}

function locateDependencyInArray(
  deps: PackageYml['packages'],
  packageName: string,
  target: DependencyTarget
): { range: string; target: DependencyTarget } | null {
  if (!deps) {
    return null;
  }

  const entry = deps.find(dep => arePackageNamesEquivalent(dep.name, packageName));
  if (!entry) {
    return null;
  }

  if (!entry.version || !entry.version.trim()) {
    throw new Error(
      `Dependency '${packageName}' in .openpackage/package.yml must declare a version range. Edit the file and try again.`
    );
  }

  return {
    range: entry.version.trim(),
    target
  };
}

function parseConstraintOrThrow(source: 'cli' | 'package', raw: string, packageName: string): ParsedConstraint {
  try {
    const parsed = parseVersionRange(raw);
    return { resolverRange: parsed.range, displayRange: parsed.original };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (source === 'cli') {
      throw new Error(
        `Invalid version spec '${raw}' provided via CLI for '${packageName}'. ${message}. Adjust the CLI input and try again.`
      );
    }

    throw new Error(
      `Dependency '${packageName}' in .openpackage/package.yml has invalid version '${raw}'. ${message}. Edit the file and try again.`
    );
  }
}

function isRangeSubset(candidate: string, canonical: string): boolean {
  try {
    return semver.subset(candidate, canonical, { includePrerelease: true });
  } catch {
    return false;
  }
}

function buildCanonicalConflictError(packageName: string, cliSpec: string, canonicalRange: string): Error {
  return new Error(
    `Requested '${packageName}@${cliSpec}', but .openpackage/package.yml declares '${packageName}' with range '${canonicalRange}'. Edit package.yml to change the dependency line, then re-run opkg install.`
  );
}

export function resolvePersistRange(
  decision: PersistDecision,
  selectedVersion: string
): { range: string; target: DependencyTarget } | null {
  if (decision.type === 'none') {
    return null;
  }

  if (decision.type === 'explicit') {
    return { range: decision.range, target: decision.target };
  }

  const derivedRange = createCaretRange(selectedVersion);
  return { range: derivedRange, target: decision.target };
}


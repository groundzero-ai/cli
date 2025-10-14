import { FormulaDependency } from '../types/index.js';

/**
 * Normalize a formula name to lowercase, handling scoped names properly.
 * Scoped names like @Scope/Name become @scope/name.
 * Regular names like MyFormula become myformula.
 */
export function normalizeFormulaName(name: string): string {
  // Handle scoped names (@scope/name format)
  const scopedMatch = name.match(/^(@[^\/]+)\/(.+)$/);
  if (scopedMatch) {
    const [, scope, localName] = scopedMatch;
    return `${scope.toLowerCase()}/${localName.toLowerCase()}`;
  }

  // Handle regular names
  return name.toLowerCase();
}

/**
 * Normalize a formula dependency by normalizing its name.
 * Returns a new dependency object with the normalized name.
 */
export function normalizeFormulaDependency(dep: FormulaDependency): FormulaDependency {
  return {
    ...dep,
    name: normalizeFormulaName(dep.name)
  };
}

/**
 * Normalize an array of formula dependencies in-place.
 */
export function normalizeFormulaDependencies(deps: FormulaDependency[]): FormulaDependency[] {
  return deps.map(normalizeFormulaDependency);
}

/**
 * Check if two formula names are equivalent (case-insensitive).
 */
export function areFormulaNamesEquivalent(name1: string, name2: string): boolean {
  return normalizeFormulaName(name1) === normalizeFormulaName(name2);
}

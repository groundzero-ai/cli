/**
 * Formatting utilities for consistent display across commands
 */

/**
 * Interface for formula table entries
 */
export interface FormulaTableEntry {
  name: string;
  version: string;
  description?: string;
  status?: string;
  type?: string;
  available?: string;
}

/**
 * Format and display a simple formula table (used by list and search commands)
 */
export function displayFormulaTable(formulas: FormulaTableEntry[], title?: string): void {
  if (title) {
    console.log(title);
    console.log('');
  }
  
  if (formulas.length === 0) {
    console.log('No formulas found.');
    return;
  }
  
  // Table header
  console.log('NAME'.padEnd(20) + 'VERSION'.padEnd(12) + 'DESCRIPTION');
  console.log('----'.padEnd(20) + '-------'.padEnd(12) + '-----------');
  
  // Display each formula
  for (const formula of formulas) {
    const name = formula.name.padEnd(20);
    const version = formula.version.padEnd(12);
    const description = formula.description || '(no description)';
    console.log(`${name}${version}${description}`);
  }
  
  console.log('');
  console.log(`Total: ${formulas.length} formulas`);
}

/**
 * Format and display an extended formula table with status information (used by status command)
 */
export function displayExtendedFormulaTable(formulas: FormulaTableEntry[]): void {
  if (formulas.length === 0) {
    console.log('No formulas found.');
    return;
  }
  
  // Table header
  console.log('FORMULA'.padEnd(20) + 'INSTALLED'.padEnd(12) + 'STATUS'.padEnd(15) + 'TYPE'.padEnd(15) + 'AVAILABLE');
  console.log('-------'.padEnd(20) + '---------'.padEnd(12) + '------'.padEnd(15) + '----'.padEnd(15) + '---------');
  
  // Display each formula
  for (const formula of formulas) {
    const name = formula.name.padEnd(20);
    const version = formula.version.padEnd(12);
    const status = (formula.status || '').padEnd(15);
    const type = (formula.type || '').padEnd(15);
    const available = (formula.available || '-').padEnd(9);
    
    console.log(`${name}${version}${status}${type}${available}`);
  }
  
  console.log('');
  console.log(`Total: ${formulas.length} formulas`);
}

/**
 * Generic table formatter for custom column layouts
 */
export function displayCustomTable<T>(
  items: T[],
  columns: Array<{
    header: string;
    width: number;
    accessor: (item: T) => string;
  }>,
  title?: string
): void {
  if (title) {
    console.log(title);
    console.log('');
  }
  
  if (items.length === 0) {
    console.log('No items found.');
    return;
  }
  
  // Build header
  const headerLine = columns.map(col => col.header.padEnd(col.width)).join('');
  const separatorLine = columns.map(col => '-'.repeat(col.header.length).padEnd(col.width)).join('');
  
  console.log(headerLine);
  console.log(separatorLine);
  
  // Display rows
  for (const item of items) {
    const row = columns.map(col => col.accessor(item).padEnd(col.width)).join('');
    console.log(row);
  }
  
  console.log('');
  console.log(`Total: ${items.length} items`);
}

/**
 * Format project summary line
 */
export function formatProjectSummary(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Format tree connector symbols
 */
export function getTreeConnector(isLast: boolean): string {
  return isLast ? '└── ' : '├── ';
}

/**
 * Format tree prefix for nested items
 */
export function getTreePrefix(prefix: string, isLast: boolean): string {
  return prefix + (isLast ? '    ' : '│   ');
}

/**
 * Format status with appropriate emoji
 */
export function formatStatus(status: string): string {
  switch (status.toLowerCase()) {
    case 'installed':
      return '✅ installed';
    case 'missing':
      return '❌ missing';
    case 'outdated':
      return '⚠️  outdated';
    case 'dependency-mismatch':
      return '🔄 mismatch';
    default:
      return status;
  }
}

/**
 * Format file count with appropriate description
 */
export function formatFileCount(count: number, type: string = 'files'): string {
  return `${count} ${count === 1 ? type.slice(0, -1) : type}`;
}

/**
 * Format dependency list for display
 */
export function formatDependencyList(dependencies: Array<{ name: string; version: string }>): string[] {
  return dependencies.map(dep => `${dep.name}@${dep.version}`);
}

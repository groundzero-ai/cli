import * as yaml from 'js-yaml';

export interface FrontmatterSplitResult<T = any> {
  frontmatter: T | null;
  body: string;
  rawFrontmatter?: string;
}

const FRONTMATTER_BOUNDARY = '---';

/**
 * Split markdown content into parsed frontmatter (if present) and body.
 */
export function splitFrontmatter<T = any>(content: string): FrontmatterSplitResult<T> {
  if (!content.trim().startsWith(FRONTMATTER_BOUNDARY)) {
    return { frontmatter: null, body: content };
  }

  const firstLineBreak = content.indexOf('\n');
  if (firstLineBreak === -1) {
    return { frontmatter: null, body: content };
  }

  const endMarkerIndex = content.indexOf(`\n${FRONTMATTER_BOUNDARY}`, firstLineBreak + 1);
  if (endMarkerIndex === -1) {
    return { frontmatter: null, body: content };
  }

  const rawFrontmatter = content
    .slice(firstLineBreak + 1, endMarkerIndex)
    .trim();

  let parsed: T | null = null;
  if (rawFrontmatter.length > 0) {
    try {
      parsed = yaml.load(rawFrontmatter) as T;
    } catch {
      // Leave parsed as null if the YAML cannot be parsed
      parsed = null;
    }
  }

  const bodyStart = endMarkerIndex + FRONTMATTER_BOUNDARY.length + 1; // +1 for newline
  const remaining = content.slice(bodyStart);
  const body = remaining.startsWith('\n') ? remaining.slice(1) : remaining;

  return {
    frontmatter: parsed,
    body,
    rawFrontmatter
  };
}

/**
 * Remove frontmatter from markdown content (if any) and return the body.
 */
export function stripFrontmatter(content: string): string {
  return splitFrontmatter(content).body;
}

/**
 * Serialize YAML data with consistent formatting.
 */
export function dumpYaml(data: any): string {
  return yaml
    .dump(data, {
      indent: 2,
      noArrayIndent: true,
      sortKeys: false,
      quotingType: '"'
    })
    .trim();
}

/**
 * Normalize YAML node for comparisons (trim strings, sort object keys).
 */
function normalizeYamlNode(node: any): any {
  if (node === null || node === undefined) {
    return null;
  }

  if (typeof node === 'string') {
    return node.trim();
  }

  if (Array.isArray(node)) {
    return node.map(normalizeYamlNode);
  }

  if (typeof node === 'object') {
    const entries = Object.entries(node as Record<string, any>)
      .map(([key, value]) => [key.trim(), normalizeYamlNode(value)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));

    const normalized: Record<string, any> = {};
    for (const [key, value] of entries) {
      normalized[key] = value;
    }
    return normalized;
  }

  return node;
}

/**
 * Deep equality for YAML data structures (ignores key order, trims strings).
 */
export function deepEqualYaml(a: any, b: any): boolean {
  return JSON.stringify(normalizeYamlNode(a)) === JSON.stringify(normalizeYamlNode(b));
}

export function isPlainObject(value: any): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Clone a YAML-compatible data structure deeply.
 */
export function cloneYaml<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * Compose markdown content with optional frontmatter.
 * If frontmatter is provided, wraps it in YAML frontmatter delimiters.
 */
export function composeMarkdown(
  frontmatter: Record<string, any> | undefined,
  body: string
): string {
  const normalizedBody = frontmatter ? body : body.replace(/^\n+/, '');

  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return normalizedBody;
  }

  const yamlContent = dumpYaml(frontmatter);
  const needsLeadingNewline = normalizedBody.startsWith('\n') ? '' : '\n';
  return `---\n${yamlContent}\n---${needsLeadingNewline}${normalizedBody}`;
}

/**
 * Normalize frontmatter value to a plain object.
 * Returns empty object if value is not a plain object.
 */
export function normalizeFrontmatter(value: any): Record<string, any> {
  if (isPlainObject(value)) {
    return cloneYaml(value);
  }
  return {};
}

/**
 * Remove keys present in `keys` from `target`, returning a new structure.
 * Keys are removed only when the value matches (deep equality with trimming).
 * Returns undefined when all keys are removed.
 */
export function subtractKeys(target: any, keys: any): any {
  if (!isPlainObject(target)) {
    if (deepEqualYaml(target, keys)) {
      return undefined;
    }
    return target;
  }

  const result: Record<string, any> = {};
  let removed = false;

  for (const [key, value] of Object.entries(target)) {
    if (keys && Object.prototype.hasOwnProperty.call(keys, key)) {
      const keyToRemove = keys[key];

      if (isPlainObject(value) && isPlainObject(keyToRemove)) {
        const nested = subtractKeys(value, keyToRemove);
        if (nested !== undefined) {
          result[key] = nested;
        } else {
          removed = true;
        }
        continue;
      }

      if (Array.isArray(value) && Array.isArray(keyToRemove)) {
        if (!deepEqualYaml(value, keyToRemove)) {
          result[key] = value;
        } else {
          removed = true;
        }
        continue;
      }

      if (deepEqualYaml(value, keyToRemove)) {
        removed = true;
        continue;
      }
    }

    result[key] = value;
  }

  if (!removed && Object.keys(result).length === Object.keys(target).length) {
    return target;
  }

  if (Object.keys(result).length === 0) {
    return undefined;
  }

  return result;
}


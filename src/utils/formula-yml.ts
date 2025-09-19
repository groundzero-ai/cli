import * as yaml from 'js-yaml';
import matter from 'gray-matter';
import { FormulaYml } from '../types/index.js';
import { readTextFile, writeTextFile } from './fs.js';

/**
 * Interface for markdown frontmatter
 */
export interface MarkdownFrontmatter {
  formula?: {
    name: string;
  };
}

/**
 * Parse formula.yml file with validation
 */
export async function parseFormulaYml(formulaYmlPath: string): Promise<FormulaYml> {
  try {
    const content = await readTextFile(formulaYmlPath);
    const parsed = yaml.load(content) as FormulaYml;
    
    // Validate required fields
    if (!parsed.name || !parsed.version) {
      throw new Error('formula.yml must contain name and version fields');
    }
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse formula.yml: ${error}`);
  }
}

/**
 * Write formula.yml file with consistent formatting
 */
export async function writeFormulaYml(formulaYmlPath: string, config: FormulaYml): Promise<void> {
  // First generate YAML with default block style
  let content = yaml.dump(config, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false
  });
  
  // Convert arrays from block style to flow style
  const flowStyleArrays = ['keywords', 'platforms'];
  
  for (const arrayField of flowStyleArrays) {
    const arrayValue = config[arrayField as keyof FormulaYml];
    if (Array.isArray(arrayValue) && arrayValue.length > 0) {
      // Split content into lines for easier processing
      const lines = content.split('\n');
      const result: string[] = [];
      let i = 0;
      
      while (i < lines.length) {
        const line = lines[i];
        
        if (line.trim() === `${arrayField}:`) {
          // Found array section, create flow style
          const arrayFlow = `${arrayField}: [${arrayValue.join(', ')}]`;
          result.push(arrayFlow);
          
          // Skip the following dash lines
          i++;
          while (i < lines.length && lines[i].trim().startsWith('-')) {
            i++;
          }
          continue;
        }
        
        result.push(line);
        i++;
      }
      
      content = result.join('\n');
    }
  }
  
  await writeTextFile(formulaYmlPath, content);
}

/**
 * Parse YAML frontmatter from markdown file content
 */
export function parseMarkdownFrontmatter(content: string): MarkdownFrontmatter | null {
  try {
    const parsed = matter(content);
    
    // If no frontmatter was found, return null
    if (!parsed.data || Object.keys(parsed.data).length === 0) {
      return null;
    }
    
    return parsed.data as MarkdownFrontmatter;
  } catch (error) {
    // If parsing fails, return null (no valid frontmatter)
    return null;
  }
}

/**
 * Update markdown content with formula frontmatter, preserving existing non-formula frontmatter and comments
 */
export function updateMarkdownWithFormulaFrontmatter(content: string, formulaName: string): string {
  // Check if content starts with frontmatter delimiter
  if (!content.startsWith('---\n')) {
    // No existing frontmatter, add new one
    const newFrontmatter = `---
# GroundZero formula
formula:
  name: ${formulaName}
---

${content}`;
    return newFrontmatter;
  }
  
  // Find the closing delimiter
  const endIndex = content.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    // Malformed frontmatter, treat as no frontmatter
    const newFrontmatter = `---
# GroundZero formula
formula:
  name: ${formulaName}
---

${content}`;
    return newFrontmatter;
  }
  
  // Extract existing frontmatter content and markdown content
  const frontmatterContent = content.substring(4, endIndex);
  const markdownContent = content.substring(endIndex + 5); // Skip the closing ---\n
  
  // Check if formula section already exists in the frontmatter
  const hasFormulaSection = frontmatterContent.includes('formula:');
  
  if (hasFormulaSection) {
    // Update existing formula section using regex to preserve comments and formatting
    const formulaRegex = /^(\s*)formula:\s*$/m;
    const formulaNameRegex = /^(\s*)name:\s*.*$/m;
    
    let updatedFrontmatter = frontmatterContent;
    
    // Update the formula name if it exists
    if (formulaNameRegex.test(updatedFrontmatter)) {
      updatedFrontmatter = updatedFrontmatter.replace(formulaNameRegex, `$1name: ${formulaName}`);
    } else {
      // Add name field if formula section exists but no name
      updatedFrontmatter = updatedFrontmatter.replace(formulaRegex, `$1formula:\n$1  name: ${formulaName}`);
    }
    
    return `---\n${updatedFrontmatter}\n---\n${markdownContent}`;
  } else {
    // No formula section exists, add it at the end of frontmatter
    const updatedFrontmatter = frontmatterContent.trim() + `\nformula:\n  name: ${formulaName}`;
    return `---\n${updatedFrontmatter}\n---\n${markdownContent}`;
  }
}

import { readFile, writeFile, chmod } from 'fs/promises';
import { exists } from './fs.js';
import { logger } from './logger.js';

/**
 * Lightweight INI file parser/writer for credentials file
 * Handles sections, key-value pairs, and comments
 */

export interface IniSection {
  [key: string]: string;
}

export interface IniFile {
  [section: string]: IniSection;
}

/**
 * Parse INI file content into structured object
 */
export function parseIni(content: string): IniFile {
  const result: IniFile = {};
  let currentSection = '';
  
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    
    // Section header [section]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1);
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }
    
    // Key-value pair
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmed.slice(0, equalIndex).trim();
      const value = trimmed.slice(equalIndex + 1).trim();
      
      if (currentSection) {
        result[currentSection][key] = value;
      } else {
        // Handle key-value pairs without section (treat as default section)
        if (!result['default']) {
          result['default'] = {};
        }
        result['default'][key] = value;
      }
    }
  }
  
  return result;
}

/**
 * Convert structured object back to INI format
 */
export function stringifyIni(data: IniFile): string {
  const lines: string[] = [];
  
  for (const [sectionName, section] of Object.entries(data)) {
    if (Object.keys(section).length > 0) {
      lines.push(`[${sectionName}]`);
      
      for (const [key, value] of Object.entries(section)) {
        lines.push(`${key} = ${value}`);
      }
      
      lines.push(''); // Empty line between sections
    }
  }
  
  return lines.join('\n');
}

/**
 * Read and parse INI file
 */
export async function readIniFile(filePath: string): Promise<IniFile> {
  try {
    if (!(await exists(filePath))) {
      logger.debug(`INI file not found: ${filePath}`);
      return {};
    }
    
    const content = await readFile(filePath, 'utf-8');
    return parseIni(content);
  } catch (error) {
    logger.error(`Failed to read INI file: ${filePath}`, { error });
    throw new Error(`Failed to read INI file: ${error}`);
  }
}

/**
 * Write INI file with proper permissions
 */
export async function writeIniFile(filePath: string, data: IniFile): Promise<void> {
  try {
    const content = stringifyIni(data);
    await writeFile(filePath, content, 'utf-8');
    
    // Set secure permissions (600) for credentials file
    await chmod(filePath, 0o600);
    
    logger.debug(`INI file written: ${filePath}`);
  } catch (error) {
    logger.error(`Failed to write INI file: ${filePath}`, { error });
    throw new Error(`Failed to write INI file: ${error}`);
  }
}

/**
 * Get a specific value from INI file
 */
export function getIniValue(data: IniFile, section: string, key: string): string | undefined {
  return data[section]?.[key];
}

/**
 * Set a specific value in INI file data
 */
export function setIniValue(data: IniFile, section: string, key: string, value: string): void {
  if (!data[section]) {
    data[section] = {};
  }
  data[section][key] = value;
}

/**
 * Remove a section from INI file data
 */
export function removeIniSection(data: IniFile, section: string): void {
  delete data[section];
}

/**
 * Check if a section exists in INI file data
 */
export function hasIniSection(data: IniFile, section: string): boolean {
  return section in data && Object.keys(data[section]).length > 0;
}

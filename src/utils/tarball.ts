import * as tar from 'tar';
import { createHash } from 'crypto';
import { unlink, readdir, stat, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { FormulaFile, Formula } from '../types/index.js';
import { logger } from './logger.js';
import { ValidationError } from './errors.js';
import { writeTextFile, readTextFile, ensureDir, exists } from './fs.js';

/**
 * Tarball utilities for formula packaging and extraction
 */

export interface TarballInfo {
  buffer: Buffer;
  size: number;
  checksum: string;
}

export interface ExtractedFormula {
  files: FormulaFile[];
  checksum: string;
}

/**
 * Create a tarball from formula files
 */
export async function createTarballFromFormula(formula: Formula): Promise<TarballInfo> {
  logger.debug(`Creating tarball for formula: ${formula.metadata.name}@${formula.metadata.version}`);
  
  const tempDir = join(tmpdir(), `g0-tarball-${Date.now()}`);
  const tarballPath = join(tempDir, 'formula.tar.gz');
  
  try {
    // Create temp directory
    await ensureDir(tempDir);
    
    // Write formula files to temp directory
    for (const file of formula.files) {
      const filePath = join(tempDir, file.path);
      await ensureDir(join(filePath, '..'));
      await writeTextFile(filePath, file.content, (file.encoding as BufferEncoding) || 'utf8');
    }
    
    // Create tarball
    await tar.create(
      {
        gzip: true,
        file: tarballPath,
        cwd: tempDir
      },
      formula.files.map(f => f.path)
    );
    
    // Read tarball into buffer
    const tarballBuffer = await readFile(tarballPath);
    
    // Calculate checksum
    const checksum = createHash('sha256').update(tarballBuffer).digest('hex');
    
    logger.debug(`Tarball created: ${tarballBuffer.length} bytes, checksum: ${checksum}`);
    
    return {
      buffer: tarballBuffer,
      size: tarballBuffer.length,
      checksum
    };
  } catch (error) {
    logger.error('Failed to create tarball', { error, formulaName: formula.metadata.name });
    throw new ValidationError(`Failed to create tarball: ${error}`);
  } finally {
    // Clean up temp directory
    try {
      if (await exists(tarballPath)) {
        await unlink(tarballPath);
      }
      // Note: We're not removing the temp dir itself as it may have subdirectories
      // The OS temp cleanup will handle this
    } catch (cleanupError) {
      logger.warn('Failed to clean up temp files', { cleanupError });
    }
  }
}

/**
 * Extract formula files from tarball buffer
 */
export async function extractFormulaFromTarball(
  tarballBuffer: Buffer, 
  expectedChecksum?: string
): Promise<ExtractedFormula> {
  logger.debug(`Extracting formula from tarball (${tarballBuffer.length} bytes)`);
  
  const tempDir = join(tmpdir(), `g0-extract-${Date.now()}`);
  const tarballPath = join(tempDir, 'formula.tar.gz');
  
  try {
    // Verify checksum if provided
    const actualChecksum = createHash('sha256').update(tarballBuffer).digest('hex');
    
    if (expectedChecksum && actualChecksum !== expectedChecksum) {
      throw new ValidationError(
        `Tarball checksum mismatch. Expected: ${expectedChecksum}, Got: ${actualChecksum}`
      );
    }
    
    // Create temp directory and write tarball
    await ensureDir(tempDir);
    await writeFile(tarballPath, tarballBuffer);
    
    // Extract tarball
    await tar.extract({
      file: tarballPath,
      cwd: tempDir
    });
    
    // Read extracted files
    const files: FormulaFile[] = [];
    const extractFiles = async (dir: string, basePath: string = ''): Promise<void> => {
      const entries = await readdir(dir);
      
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const relativePath = basePath ? join(basePath, entry) : entry;
        
        const stats = await stat(fullPath);
        if (stats.isFile()) {
          const content = await readTextFile(fullPath);
          files.push({
            path: relativePath,
            content,
            encoding: 'utf8'
          });
        } else if (stats.isDirectory()) {
          await extractFiles(fullPath, relativePath);
        }
      }
    };
    
    await extractFiles(tempDir);
    
    // Remove the tarball file itself from the list
    const filteredFiles = files.filter(f => f.path !== 'formula.tar.gz');
    
    logger.debug(`Extracted ${filteredFiles.length} files from tarball`);
    
    return {
      files: filteredFiles,
      checksum: actualChecksum
    };
  } catch (error) {
    logger.error('Failed to extract tarball', { error });
    throw new ValidationError(`Failed to extract tarball: ${error}`);
  } finally {
    // Clean up temp files
    try {
      if (await exists(tarballPath)) {
        await unlink(tarballPath);
      }
    } catch (cleanupError) {
      logger.warn('Failed to clean up temp files', { cleanupError });
    }
  }
}

/**
 * Create FormData for multipart upload
 */
export function createFormDataForUpload(
  formulaName: string,
  version: string,
  tarballInfo: TarballInfo
): FormData {
  const formData = new FormData();
  
  // Add form fields
  formData.append('name', formulaName);
  formData.append('version', version);
  
  // Add tarball file
  const blob = new Blob([tarballInfo.buffer], { type: 'application/gzip' });
  formData.append('file', blob, `${formulaName}-${version}.tgz`);
  
  return formData;
}

/**
 * Verify tarball integrity
 */
export function verifyTarballIntegrity(
  buffer: Buffer,
  expectedSize?: number,
  expectedChecksum?: string
): boolean {
  try {
    // Check size
    if (expectedSize && buffer.length !== expectedSize) {
      logger.warn('Tarball size mismatch', { 
        expected: expectedSize, 
        actual: buffer.length 
      });
      return false;
    }
    
    // Check checksum
    if (expectedChecksum) {
      const actualChecksum = createHash('sha256').update(buffer).digest('hex');
      if (actualChecksum !== expectedChecksum) {
        logger.warn('Tarball checksum mismatch', { 
          expected: expectedChecksum, 
          actual: actualChecksum 
        });
        return false;
      }
    }
    
    return true;
  } catch (error) {
    logger.error('Tarball integrity check failed', { error });
    return false;
  }
}


import { AuthOptions } from '../types/index.js';
import { authManager } from '../core/auth.js';
import { logger } from './logger.js';
import { ApiError } from '../types/api.js';

/**
 * HTTP client for API requests with authentication support
 */

export interface RequestOptions {
  headers?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  baseUrl: string;
  authOptions?: AuthOptions;
  timeout?: number;
}

export class HttpClient {
  private baseUrl: string;
  private authOptions: AuthOptions;
  private timeout: number;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl.endsWith('/') 
      ? options.baseUrl.slice(0, -1) 
      : options.baseUrl;
    this.authOptions = options.authOptions || {};
    this.timeout = options.timeout || 30000; // 30 seconds default
  }

  /**
   * Make a GET request
   */
  async get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', endpoint, undefined, options);
  }

  /**
   * Make a POST request with JSON body
   */
  async post<T>(endpoint: string, data?: any, options?: RequestOptions): Promise<T> {
    const headers = {
      'Content-Type': 'application/json',
      ...options?.headers
    };
    
    return this.request<T>('POST', endpoint, data ? JSON.stringify(data) : undefined, {
      ...options,
      headers
    });
  }

  /**
   * Upload form data (multipart/form-data)
   */
  async uploadFormData<T>(endpoint: string, formData: FormData, options?: RequestOptions): Promise<T> {
    // Don't set Content-Type header for FormData - fetch will set it automatically with boundary
    const headers = { ...options?.headers };
    delete headers['Content-Type'];
    
    return this.request<T>('POST', endpoint, formData, {
      ...options,
      headers
    });
  }

  /**
   * Download a file from a URL
   */
  async downloadFile(url: string, options?: RequestOptions): Promise<ArrayBuffer> {
    logger.debug(`Downloading file from: ${url}`);
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: options?.signal || controller.signal,
        headers: options?.headers
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status} ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      logger.debug(`Downloaded ${arrayBuffer.byteLength} bytes`);
      
      return arrayBuffer;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Download timeout after ${this.timeout}ms`);
      }
      
      logger.debug('Download failed', { error, url });
      throw error;
    }
  }

  /**
   * Core request method
   */
  private async request<T>(
    method: string, 
    endpoint: string, 
    body?: string | FormData, 
    options?: RequestOptions
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    logger.debug(`${method} ${url}`);
    
    // Get authentication headers
    const authHeaders = await this.getAuthHeaders();
    
    // Merge headers
    const headers = {
      ...authHeaders,
      ...options?.headers
    };
    
    // Setup abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: options?.signal || controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Handle non-2xx responses
      if (!response.ok) {
        await this.handleErrorResponse(response);
      }
      
      // Parse response based on content type
      const responseContentType = response.headers.get('content-type') || '';
      let parsedBody: any;
      if (responseContentType.includes('application/json')) {
        parsedBody = await response.json();
      } else {
        parsedBody = await response.text();
      }
      logger.debug(`${method} ${url} - Success`);
      
      return parsedBody as T;
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${this.timeout}ms`);
      }
      
      logger.debug(`${method} ${url} failed`, { error });
      throw error;
    }
  }

  /**
   * Get authentication headers
   */
  private async getAuthHeaders(): Promise<Record<string, string>> {
    try {
      return await authManager.getAuthHeaders(this.authOptions);
    } catch (error) {
      logger.error('Failed to get authentication headers', { error });
      throw error;
    }
  }

  /**
   * Handle error responses and throw appropriate errors
   */
  private async handleErrorResponse(response: Response): Promise<never> {
    const contentType = response.headers.get('content-type');
    let errorData: any;
    
    try {
      if (contentType?.includes('application/json')) {
        errorData = await response.json();
      } else {
        errorData = { message: await response.text() };
      }
    } catch {
      errorData = { message: `HTTP ${response.status} ${response.statusText}` };
    }
    
    const apiError: ApiError = {
      error: errorData.error || 'API_ERROR',
      message: errorData.message || `HTTP ${response.status} ${response.statusText}`,
      statusCode: response.status,
      details: errorData.details
    };
    
    logger.debug('API request failed', { 
      status: response.status, 
      statusText: response.statusText,
      error: apiError 
    });
    
    // Create appropriate error message based on status code
    let errorMessage = apiError.message;
    
    switch (response.status) {
      case 401:
        errorMessage = 'Authentication failed. Please check your API key.';
        break;
      case 403:
        errorMessage = 'Access denied. You may not have permission to access this resource.';
        break;
      case 404:
        errorMessage = 'Resource not found.';
        break;
      case 409:
        errorMessage = errorData.message || 'Conflict - resource already exists.';
        break;
      case 422:
        errorMessage = errorData.message || 'Validation failed.';
        break;
      case 429:
        errorMessage = 'Rate limit exceeded. Please try again later.';
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        errorMessage = 'Server error. Please try again later.';
        break;
    }
    
    const error = new Error(errorMessage);
    (error as any).apiError = apiError;
    throw error;
  }
}

/**
 * Create an HTTP client instance for the configured registry
 */
export async function createHttpClient(authOptions?: AuthOptions): Promise<HttpClient> {
  const { registryUrl } = await authManager.validateAuth(authOptions);
  
  return new HttpClient({
    baseUrl: registryUrl,
    authOptions,
    timeout: parseInt(process.env.G0_API_TIMEOUT || '30000')
  });
}

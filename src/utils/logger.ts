import { Logger, LogLevel } from '../types/index.js';

/**
 * Simple console-based logger with support for different log levels
 */
class ConsoleLogger implements Logger {
  private level: LogLevel;

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    const currentLevelIndex = levels.indexOf(this.level);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  private formatMessage(level: LogLevel, message: string, meta?: any): string {
    const timestamp = new Date().toISOString();
    const prefix = this.getPrefix(level);
    let formatted = `${timestamp} ${prefix} ${message}`;
    
    if (meta && typeof meta === 'object') {
      formatted += `\n${JSON.stringify(meta, null, 2)}`;
    } else if (meta) {
      formatted += ` ${meta}`;
    }
    
    return formatted;
  }

  private getPrefix(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG:
        return '🐛 [DEBUG]';
      case LogLevel.INFO:
        return 'ℹ️  [INFO] ';
      case LogLevel.WARN:
        return '⚠️  [WARN] ';
      case LogLevel.ERROR:
        return '❌ [ERROR]';
      default:
        return '[LOG]  ';
    }
  }

  debug(message: string, meta?: any): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.debug(this.formatMessage(LogLevel.DEBUG, message, meta));
    }
  }

  info(message: string, meta?: any): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.info(this.formatMessage(LogLevel.INFO, message, meta));
    }
  }

  warn(message: string, meta?: any): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn(this.formatMessage(LogLevel.WARN, message, meta));
    }
  }

  error(message: string, meta?: any): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error(this.formatMessage(LogLevel.ERROR, message, meta));
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

// Create and export a default logger instance
export const logger = new ConsoleLogger(
  process.env.NODE_ENV === 'development' ? LogLevel.DEBUG : LogLevel.INFO
);

// Export the logger class for custom instances
export { ConsoleLogger };

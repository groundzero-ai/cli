/**
 * Simple spinner utility for showing loading indicators in CLI
 */

export class Spinner {
  private intervalId: NodeJS.Timeout | null = null;
  private message: string;
  private frames: string[];
  private currentFrame: number = 0;
  private isRunning: boolean = false;

  constructor(message: string = 'Loading...') {
    this.message = message;
    // Different spinner frames for variety
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  }

  /**
   * Start the spinner animation
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.currentFrame = 0;

    // Hide cursor for cleaner output
    process.stdout.write('\x1B[?25l');

    this.intervalId = setInterval(() => {
      const frame = this.frames[this.currentFrame % this.frames.length];
      process.stdout.write(`\r${frame} ${this.message}`);
      this.currentFrame++;
    }, 80); // Update every 80ms for smooth animation
  }

  /**
   * Update the spinner message
   */
  update(message: string): void {
    this.message = message;
  }

  /**
   * Stop the spinner
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    // Clear the spinner line
    process.stdout.write('\r' + ' '.repeat(process.stdout.columns || 80) + '\r');

    // Show cursor again
    process.stdout.write('\x1B[?25h');
  }

  /**
   * Convenience method to run an async operation with a spinner
   */
  static async run<T>(
    message: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const spinner = new Spinner(message);
    spinner.start();

    try {
      const result = await operation();
      spinner.stop();
      return result;
    } catch (error) {
      spinner.stop();
      throw error;
    }
  }
}


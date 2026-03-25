export class Logger {
  private logger: Console;

  constructor(loggerInstance: Console) {
    this.logger = loggerInstance;
  }

  log(message: unknown): void {
    this.logger.log(
      `log :: ${new Date().toISOString()} - ${this.stringify(message)}`,
    );
  }

  error(message: unknown): void {
    this.logger.error(
      `error :: ${new Date().toISOString()} - ${this.stringify(message)}`,
    );
  }

  warn(message: unknown): void {
    this.logger.warn(
      `warn :: ${new Date().toISOString()} - ${this.stringify(message)}`,
    );
  }

  stringify(data: unknown): string {
    return JSON.stringify(data, null, 2);
  }

  formatAddress(address: string): string {
    if (!address || address.length < 10) {
      return address;
    }
    const cleanAddress = address.startsWith("0x") ? address.slice(2) : address;
    return `${cleanAddress.slice(0, 5)}...${cleanAddress.slice(-5)}`;
  }
}

export const logger = new Logger(console);

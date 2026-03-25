import { ethers } from "ethers";
import { logger } from "../../lib/utils/logger";
import { getIsShuttingDown } from "../../lib/utils/shutdown-state";

const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 60000;

const HTTP_503_PATTERNS = [
  "503",
  "Service Unavailable",
  "service temporarily unavailable",
  "server is overloaded",
  "temporarily unavailable",
];

export function is503Error(error: any): boolean {
  if (!error) return false;
  const message = error.message || "";
  const code = error.code || "";
  return HTTP_503_PATTERNS.some(
    (pattern) =>
      message.toLowerCase().includes(pattern.toLowerCase()) ||
      code.toString().includes("503"),
  );
}

export class WsConnection {
  private wssUrl: string;
  private getLogPrefix: () => string;
  private onReconnected: () => Promise<void>;
  private provider: ethers.WebSocketProvider | null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null;
  private isReconnecting: boolean;
  private reconnectAttempts: number;

  constructor(opts: {
    wssUrl: string;
    getLogPrefix: () => string;
    onReconnected: () => Promise<void>;
  }) {
    this.wssUrl = opts.wssUrl;
    this.getLogPrefix = opts.getLogPrefix;
    this.onReconnected = opts.onReconnected;
    this.provider = null;
    this.heartbeatInterval = null;
    this.isReconnecting = false;
    this.reconnectAttempts = 0;
  }

  async initialize(): Promise<void> {
    const prefix = this.getLogPrefix();
    logger.log(
      `${prefix} [Provider] Initializing WebSocket provider to ${this.wssUrl}`,
    );

    this.provider = new ethers.WebSocketProvider(this.wssUrl);
    await this.provider.ready;

    logger.log(
      `${prefix} [Provider] WebSocket provider initialized successfully`,
    );
    this.setupConnectionMonitoring();
  }

  private setupConnectionMonitoring(): void {
    const prefix = this.getLogPrefix();
    logger.log(
      `${prefix} [WebSocket] Setting up connection monitoring for ${this.wssUrl}`,
    );

    this.provider?.on("error", (error: Error) => {
      logger.warn(`${prefix} [Provider] Issue detected: ${error.message}`);
      this.handleDisconnection("provider_error");
    });

    const websocket =
      (this.provider as any).websocket || (this.provider as any)._websocket;
    if (websocket) {
      websocket.on("close", (code: number, reason: string) => {
        logger.log(
          `${prefix} [WebSocket] Connection closed - Code: ${code}, Reason: ${
            reason || "No reason provided"
          }`,
        );
        this.handleDisconnection("websocket_close");
      });

      websocket.on("error", (error: Error) => {
        logger.warn(`${prefix} [WebSocket] Issue detected: ${error.message}`);
        this.handleDisconnection("websocket_error");
      });

      logger.log(
        `${prefix} [WebSocket] Connection monitoring established on WebSocket`,
      );
    } else {
      logger.log(
        `${prefix} [WebSocket] Direct WebSocket access not available, relying on provider events and heartbeat`,
      );
    }
  }

  startHeartbeat(): void {
    this.stopHeartbeat();

    const prefix = this.getLogPrefix();
    logger.log(
      `${prefix} [Heartbeat] Starting heartbeat with ${HEARTBEAT_INTERVAL}ms interval`,
    );

    this.heartbeatInterval = setInterval(async () => {
      const prefix = this.getLogPrefix();
      try {
        logger.log(`${prefix} [Heartbeat] Sending ping to ${this.wssUrl}`);

        const blockNumber = await Promise.race([
          this.provider?.getBlockNumber(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Heartbeat timeout")),
              HEARTBEAT_TIMEOUT,
            ),
          ),
        ]);

        logger.log(
          `${prefix} [Heartbeat] Pong received - Block: ${blockNumber}`,
        );
      } catch (error: any) {
        logger.warn(`${prefix} [Heartbeat] Failed: ${error.message}`);
        this.handleDisconnection("heartbeat_failure");
      }
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      const prefix = this.getLogPrefix();
      logger.log(`${prefix} [Heartbeat] Stopped`);
    }
  }

  private async handleDisconnection(reason: string): Promise<void> {
    const prefix = this.getLogPrefix();

    const shuttingDown = getIsShuttingDown();
    logger.log(
      `${prefix} [Reconnect] Disconnection detected - Reason: ${reason}, isShuttingDown: ${shuttingDown}`,
    );

    if (shuttingDown) {
      logger.log(
        `${prefix} [Reconnect] Process is shutting down, skipping reconnection attempt`,
      );
      this.stopHeartbeat();
      return;
    }

    if (this.isReconnecting) {
      logger.log(
        `${prefix} [Reconnect] Already attempting to reconnect, skipping duplicate trigger...`,
      );
      return;
    }

    logger.log(
      `${prefix} [Reconnect] Starting reconnection process for reason: ${reason}`,
    );
    this.isReconnecting = true;
    this.stopHeartbeat();

    let attempt = 0;
    let delay = INITIAL_RECONNECT_DELAY;

    while (attempt < MAX_RECONNECT_ATTEMPTS) {
      attempt++;
      logger.log(
        `${prefix} [Reconnect] Attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} - Waiting ${delay}ms before reconnecting...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        await this.reconnect();
        logger.log(
          `${prefix} [Reconnect] Successfully reconnected on attempt ${attempt}`,
        );
        this.isReconnecting = false;
        this.reconnectAttempts = 0;

        process?.send?.({
          status: "reconnected",
          attempt,
          pid: process.pid,
        });

        return;
      } catch (error: any) {
        const is503 = is503Error(error);
        logger.warn(
          `${prefix} [Reconnect] Attempt ${attempt} failed: ${error.message}${
            is503 ? " (503 Service Unavailable)" : ""
          }`,
        );
        if (is503) {
          delay = Math.min(delay * 3, MAX_RECONNECT_DELAY);
        } else {
          delay = Math.min(delay * 2, MAX_RECONNECT_DELAY);
        }
      }
    }

    logger.warn(
      `${prefix} [Reconnect] Max attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Connection permanently lost.`,
    );
    this.isReconnecting = false;

    process?.send?.({
      status: "disconnected",
      reason: "max_reconnect_attempts",
      pid: process.pid,
    });

    logger.log(`${prefix} [Reconnect] Cleaning up and exiting process...`);
    await this.destroy();
    process.exit(1);
  }

  private async reconnect(): Promise<void> {
    const prefix = this.getLogPrefix();
    logger.log(`${prefix} [Reconnect] Starting reconnection process...`);

    if (this.provider) {
      try {
        logger.log(`${prefix} [Reconnect] Destroying old provider...`);
        await this.provider.destroy();
        logger.log(`${prefix} [Reconnect] Old provider destroyed`);
      } catch (e: any) {
        logger.log(
          `${prefix} [Reconnect] Error destroying old provider: ${e.message}`,
        );
      }
    }

    logger.log(
      `${prefix} [Reconnect] Creating new WebSocket provider to ${this.wssUrl}`,
    );

    try {
      this.provider = new ethers.WebSocketProvider(this.wssUrl);

      logger.log(`${prefix} [Reconnect] Waiting for provider to be ready...`);
      await this.provider.ready;
      logger.log(`${prefix} [Reconnect] Provider is ready`);
    } catch (error: any) {
      if (is503Error(error)) {
        logger.warn(
          `${prefix} [Reconnect] 503 Service Unavailable during reconnection: ${error.message}`,
        );
        throw new Error(`503 Service Unavailable: ${error.message}`);
      }
      throw error;
    }

    this.setupConnectionMonitoring();

    logger.log(`${prefix} [Reconnect] Re-establishing event listener...`);
    await this.onReconnected();

    logger.log(
      `${prefix} [Reconnect] Reconnection complete - Event listener active`,
    );
  }

  async destroy(): Promise<void> {
    const prefix = this.getLogPrefix();
    logger.log(`${prefix} [Cleanup] Destroying WsConnection...`);

    this.stopHeartbeat();

    if (this.provider) {
      try {
        await this.provider.destroy();
        logger.log(`${prefix} [Cleanup] Provider destroyed`);
      } catch (e: any) {
        logger.log(
          `${prefix} [Cleanup] Error destroying provider: ${e.message}`,
        );
      }
    }

    logger.log(`${prefix} [Cleanup] WsConnection destroyed`);
  }

  getProvider(): ethers.WebSocketProvider | null {
    return this.provider;
  }

  removeEventFilter(filter: any): void {
    try {
      this.provider?.off(filter);
    } catch (e: any) {
      const prefix = this.getLogPrefix();
      logger.log(`${prefix} [Cleanup] Error removing listener: ${e.message}`);
    }
  }

  on(filter: any, callback: (log: ethers.Log) => void): any {
    return this.provider?.on(filter, callback);
  }
}

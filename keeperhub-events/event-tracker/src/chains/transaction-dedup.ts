import Redis from "ioredis";
import { NODE_ENV } from "../../lib/config/environment";
import { logger } from "../../lib/utils/logger";

export class TransactionDedup {
  private redis: Redis;
  private keeperId: string;

  constructor(
    keeperId: string,
    redisHost: string,
    redisPort: number,
    redisPassword?: string,
  ) {
    this.keeperId = keeperId;
    this.redis = new Redis({
      host: redisHost,
      port: redisPort,
      ...(redisPassword && { password: redisPassword }),
    });
  }

  private getKey(transactionHash: string): string {
    const key = `${NODE_ENV}:keeper_id:${this.keeperId}:processed_tx:${transactionHash}`;
    logger.log(`[Redis] Generated key: ${key}`);
    return key;
  }

  async isProcessed(transactionHash: string): Promise<boolean> {
    const key = this.getKey(transactionHash);
    const exists = await this.redis.exists(key);
    logger.log(`[Redis] Checked key ${key} - exists: ${exists === 1}`);
    return exists === 1;
  }

  async markProcessed(transactionHash: string): Promise<void> {
    const key = this.getKey(transactionHash);
    await this.redis.set(key, "1", "EX", 24 * 60 * 60);
    logger.log(`[Redis] Stored key ${key} with 24h TTL`);
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}

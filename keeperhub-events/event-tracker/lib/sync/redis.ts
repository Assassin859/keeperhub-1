import os from "node:os";
import { Redis } from "ioredis";
import { v7 as uuid } from "uuid";
import {
  NODE_ENV,
  REDIS_HOST,
  REDIS_PASSWORD,
  REDIS_PORT,
} from "../config/environment";
import { type Logger, logger } from "../utils/logger";

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  ...(REDIS_PASSWORD && { password: REDIS_PASSWORD }),
});

interface ProcessRecord {
  containerId: string | null;
  pid: string | null;
  event: string | null;
  timestamp: string | null;
}

class SyncManager {
  protected rtStorage: Redis;
  protected logger: Logger;
  public containerId: string;

  constructor(rtStorage: Redis, loggerInstance: Logger) {
    this.rtStorage = rtStorage;
    this.logger = loggerInstance;
    this.containerId = `${NODE_ENV}-${os.hostname()}-${uuid()}`;
  }

  buildProcessKey(containerId: string, index: string): string {
    return `container:${NODE_ENV}-${containerId}-process:${index}`;
  }

  buildContainerKey(containerId: string): string {
    return `container:${NODE_ENV}-${containerId}`;
  }

  buildContainerProcessesKey(containerId: string): string {
    return `container-processes:${NODE_ENV}-${containerId}`;
  }
}

class SyncContainerManager extends SyncManager {
  async registerContainer(): Promise<void> {
    this.logger.log(
      `[Sync] registerContainer: Registering container ${this.containerId} for ${NODE_ENV}`,
    );
    await this.rtStorage.rpush(`containers:${NODE_ENV}`, this.containerId);

    const allContainers = await this.getContainers();
    this.logger.log(
      `[Sync] registerContainer: Container ${this.containerId} registered. Total containers for ${NODE_ENV}: ${allContainers.length}`,
    );
  }

  async getContainerProcesses(): Promise<string[]> {
    const processes = await this.rtStorage.lrange(
      this.buildContainerProcessesKey(this.containerId),
      0,
      -1,
    );
    return processes;
  }

  async getContainerProcessesById(id: string): Promise<string[]> {
    const processes = await this.rtStorage.lrange(
      this.buildContainerProcessesKey(id),
      0,
      -1,
    );
    return processes;
  }

  async getContainers(): Promise<string[]> {
    const containers = await this.rtStorage.lrange(
      `containers:${NODE_ENV}`,
      0,
      -1,
    );
    return containers;
  }

  async removeContainer(): Promise<void> {
    await this.removeAllContainerProcesses(this.containerId);

    await this.rtStorage.lrem(`containers:${NODE_ENV}`, 0, this.containerId);

    this.logger.log(
      `Container ${this.containerId} removed - timestamp ${Date.now()}`,
    );
  }

  async removeAllContainers(): Promise<void> {
    try {
      const allContainers = await this.getContainers();

      this.logger.log(
        `[Sync] removeAllContainers: Found ${allContainers.length} containers for ${NODE_ENV}: [${allContainers.join(", ")}]`,
      );

      for (const container of allContainers) {
        this.logger.log(
          `[Sync] removeAllContainers: Removing processes for container ${container}`,
        );
        await this.removeAllContainerProcesses(container);
      }

      await this.rtStorage.del(`containers:${NODE_ENV}`);

      this.logger.log(
        `[Sync] removeAllContainers: All containers removed for ${NODE_ENV}`,
      );
    } catch (error: any) {
      this.logger.warn(`Failed to remove containers: ${error.message}`);
    }
  }

  async removeAllContainerProcesses(id: string): Promise<void> {
    try {
      await this.rtStorage.del(this.buildContainerProcessesKey(id));

      this.logger.log(`Container processes removed for container ${id}`);
    } catch (error: any) {
      this.logger.warn(
        `Failed to remove container processes: ${error.message}`,
      );
    }
  }

  async removeContainerById(id: string): Promise<void> {
    await this.removeAllContainerProcesses(id);

    await this.rtStorage.lrem(`containers:${NODE_ENV}`, 0, id);

    this.logger.log(`Container ${id} removed - timestamp ${Date.now()}`);
  }
}

class SyncProcessManager extends SyncContainerManager {
  async registerProcess(
    index: string,
    pid: number,
    event: { id: string },
  ): Promise<void> {
    try {
      await this.rtStorage.hset(this.buildProcessKey(this.containerId, index), {
        containerId: this.containerId,
        pid: pid.toString(),
        event: event.id,
        timestamp: Date.now().toString(),
      });

      this.logger.log(
        `Process [${index}] registered with pid ${pid} and event ${event.id} - container ${this.containerId}`,
      );

      await this.rtStorage.rpush(
        this.buildContainerProcessesKey(this.containerId),
        index,
      );
    } catch (error: any) {
      this.logger.warn(
        `Failed to register process [${index}]: ${error.message}`,
      );
    }
  }

  async getProcess(index: string): Promise<ProcessRecord> {
    const processKey = this.buildProcessKey(this.containerId, index);

    const eventId = await this.rtStorage.hget(processKey, "event");
    const containerId = await this.rtStorage.hget(processKey, "containerId");
    const pid = await this.rtStorage.hget(processKey, "pid");
    const timestamp = await this.rtStorage.hget(processKey, "timestamp");

    return {
      containerId,
      pid,
      event: eventId,
      timestamp,
    };
  }

  async getProcessByContainer(
    containerId: string,
    index: string,
  ): Promise<ProcessRecord> {
    const processKey = this.buildProcessKey(containerId, index);
    const eventId = await this.rtStorage.hget(processKey, "event");
    const containerData = await this.rtStorage.hget(processKey, "containerId");
    const pid = await this.rtStorage.hget(processKey, "pid");
    const timestamp = await this.rtStorage.hget(processKey, "timestamp");

    return {
      containerId: containerData,
      pid,
      event: eventId,
      timestamp,
    };
  }

  async removeProcess(index: string): Promise<void> {
    try {
      const processKey = this.buildProcessKey(this.containerId, index);
      const containerProcessesKey = this.buildContainerProcessesKey(
        this.containerId,
      );

      await this.rtStorage.del(processKey);
      await this.rtStorage.lrem(containerProcessesKey, 0, index);

      this.logger.log(
        `Process [${index}] removed from container ${this.containerId}`,
      );
    } catch (error: any) {
      this.logger.warn(`Failed to remove process [${index}]: ${error.message}`);
    }
  }
}

export class SyncModule extends SyncProcessManager {
  async isWorkflowRunningOnThisContainer(
    index: string,
  ): Promise<boolean | undefined> {
    try {
      const containerProcesses = await this.getContainerProcesses();
      const keeperProcess = await this.getProcess(index);
      return containerProcesses.includes(keeperProcess.event!);
    } catch (error: any) {
      this.logger.warn(
        `Failed to check if Keeper is running on this container: ${error.message}`,
      );
    }
  }

  async isWorkflowAlreadyRunningInAnotherContainer(
    index: string,
  ): Promise<boolean | undefined> {
    try {
      let keeperAlreadyRunning = false;
      const containersRegistered = await this.getContainers();

      this.logger.log(
        `[Sync] Checking workflow ${index} - Current container: ${this.containerId}, Registered containers: ${containersRegistered.length}`,
      );

      for (const container of containersRegistered) {
        if (container === this.containerId) {
          this.logger.log(`[Sync] Skipping current container: ${container}`);
          continue;
        }

        const containerProcesses =
          await this.getContainerProcessesById(container);

        this.logger.log(
          `[Sync] Container ${container} has processes: [${containerProcesses.join(", ")}]`,
        );

        if (containerProcesses.includes(index)) {
          this.logger.log(
            `[Sync] Workflow ${index} is already running in container ${container}`,
          );
          keeperAlreadyRunning = true;
          break;
        }
      }

      this.logger.log(
        `[Sync] Workflow ${index} running elsewhere: ${keeperAlreadyRunning}`,
      );
      return keeperAlreadyRunning;
    } catch (error: any) {
      this.logger.warn(
        `Failed to check if Keeper is running in another container: ${error.message}`,
      );
    }
  }
}

export const syncModule = new SyncModule(redis, logger);

import { type ChildProcess, fork } from "node:child_process";
import { join } from "node:path";
import type { WorkflowEvent } from "../../lib/models/workflow-event";
import type { SyncModule } from "../../lib/sync/redis";
import type { NetworksWrapper, ProcessEntry } from "../../lib/types";
import { EXIT_CODES } from "../../lib/utils/constants";
import type { Logger } from "../../lib/utils/logger";

export class WorkflowHandler {
  event: WorkflowEvent;
  rawEventData: any;
  index: string;
  logger: Logger;
  syncService: SyncModule;
  networks: NetworksWrapper;
  currentProcess: ProcessEntry;
  shouldRestart: boolean;

  constructor({
    event,
    logger,
    syncService,
    index,
    networks,
    rawEventData,
  }: {
    event: WorkflowEvent;
    logger: Logger;
    syncService: SyncModule;
    index: string;
    networks: NetworksWrapper;
    rawEventData: any;
  }) {
    this.event = event;
    this.rawEventData = rawEventData;
    this.index = index;
    this.logger = logger;
    this.syncService = syncService;
    this.networks = networks;

    this.currentProcess = { process: null, handler: this };
    this.shouldRestart = false;
  }

  async startProcess(): Promise<void> {
    const childPath = join(import.meta.dirname, "../child-handler.ts");
    const _process = fork(childPath, [this.index.toString()], {
      execArgv: ["--import", "tsx/esm"],
    });

    this.setActiveProcess(_process);

    _process.on("message", (msg: any) => {
      if (!Object.keys(msg).includes("watch:require")) {
        this.logger.log(
          `Process [ ${this.logger.stringify(
            this.currentProcess.process?.pid,
          )} ] received message: ${this.logger.stringify(msg)}`,
        );
      }
    });

    _process.on("exit", async (code: number | null, signal: string | null) => {
      this.logger.warn(
        `Process [${this.index}] exited with code ${code}, signal ${signal}`,
      );

      if (code === EXIT_CODES.VALIDATION_ERROR) {
        this.logger.warn(
          `Process [${this.index}] exited due to validation issue (code ${EXIT_CODES.VALIDATION_ERROR}). This indicates an invalid contract address or ABI configuration. Not restarting until configuration is fixed.`,
        );
        await this.syncService.removeProcess(this.index);
        return;
      }

      if (!this.shouldRestart) {
        this.logger.log(
          `Process [${this.index}] terminated intentionally. Not restarting.`,
        );
        await this.syncService.removeProcess(this.index);
        return;
      }

      if (code === EXIT_CODES.TRANSIENT_ERROR) {
        this.logger.log(
          `Process [${this.index}] exited with transient error (code ${EXIT_CODES.TRANSIENT_ERROR}). Restarting...`,
        );
      } else {
        this.logger.log(`Restarting child process [${this.index}]`);
      }

      await this.syncService.removeProcess(this.index);
      this.startProcess();
    });

    _process.on("error", async (err: Error) => {
      this.logger.warn(err);
      this.logger.warn(`Child process issue [${this.index}]: ${err.message}`);
      this.logger.log(`Restarting child process [${this.index}]`);

      await this.syncService.removeProcess(this.index);

      this.startProcess();
    });

    if (!_process.pid) {
      this.logger.error(
        `Failed to spawn child process for workflow [${this.index}]`,
      );
      return;
    }

    await this.syncService.registerProcess(this.index, _process.pid, {
      id: this.event.id!,
    });

    const networksToSend = (this.networks as any).networks
      ? this.networks
      : { networks: this.networks };

    _process.send({
      event: this.rawEventData,
      networks: networksToSend,
    });

    this.logger.log(
      `Child process running: [ WorkflowId: ${this.index} ] - Chain: ${this.event.chain}`,
    );
  }

  async killWorkflow({
    shouldRestart = false,
  }: {
    shouldRestart: boolean;
  }): Promise<void> {
    this.shouldRestart = shouldRestart;

    this.logger.log(
      `Killing workflow [ ${this.event.id} ] - shouldRestart: ${shouldRestart}`,
    );

    if (this.currentProcess?.process) {
      if (this.currentProcess.process.killed) {
        this.logger.log(
          `Process [ ${this.currentProcess.process.pid} ] already killed`,
        );
      } else {
        const pid = this.currentProcess.process.pid;
        this.logger.log(
          `Killing child process [ ${pid} ] for workflow [ ${this.event.id} ]`,
        );

        const exitPromise = new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            this.logger.warn(
              `Process [ ${pid} ] did not exit within 5 seconds, forcing kill`,
            );
            try {
              this.currentProcess.process?.kill("SIGKILL");
            } catch (_e) {
              // Process might already be dead
            }
            resolve();
          }, 5000);

          this.currentProcess.process?.once("exit", () => {
            clearTimeout(timeout);
            this.logger.log(`Process [ ${pid} ] exited successfully`);
            resolve();
          });
        });

        this.currentProcess.process.kill("SIGTERM");
        this.logger.log(`Kill signal (SIGTERM) sent to process [ ${pid} ]`);

        await exitPromise;
      }
    } else {
      this.logger.warn(
        `No process found for workflow [ ${this.event.id} ], cannot kill process`,
      );
    }

    this.logger.log(
      `Removing workflow [ ${this.event.id} ] from Redis to prevent duplicate processing`,
    );
    await this.syncService.removeProcess(this.event.id!);
    this.logger.log(
      `Workflow [ ${this.event.id} ] removed from Redis successfully`,
    );
  }

  async restartWorkflowWithAnotherEvent(
    event: WorkflowEvent,
    rawEventData: any,
  ): Promise<this> {
    this.event = event;
    this.rawEventData = rawEventData;
    await this.killWorkflow({ shouldRestart: false });

    await this.startProcess();

    return this;
  }

  setActiveProcess(currentProcess: ChildProcess): void {
    this.currentProcess = {
      process: currentProcess,
      handler: this,
    };
  }
}

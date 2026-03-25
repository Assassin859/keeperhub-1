import type { WorkflowEvent } from "../../lib/models/workflow-event";
import type { NetworksWrapper } from "../../lib/types";
import type { Logger } from "../../lib/utils/logger";
import { EvmChain } from "./evm-chain";

export class EventHandlerFactory {
  private options: WorkflowEvent;
  private logger: Logger;
  private networks: NetworksWrapper;

  constructor(
    options: WorkflowEvent,
    logger: Logger,
    networks: NetworksWrapper,
  ) {
    this.options = options;
    this.logger = logger;
    this.networks = networks;
  }

  buildChainHandler(): EvmChain {
    return new EvmChain(this.options, this.logger, this.networks);
  }
}

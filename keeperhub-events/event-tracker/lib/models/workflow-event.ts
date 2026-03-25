import deepDiff from "deep-diff";
const { diff } = deepDiff;

interface WorkflowEventOptions {
  id: string;
  name: string;
  userId: string;
  organizationId: string;
  enabled: boolean;
  nodes: NodeOptions[];
}

interface WorkflowOptions {
  id: string;
  name: string;
  userId: string;
  organizationId: string;
  enabled: boolean;
  node: NodeOptions;
}

interface NodeOptions {
  id: string;
  data: NodeDataOptions;
  type: string;
  selected: boolean;
}

interface NodeDataOptions {
  type: string;
  label: string;
  config: NodeConfigOptions;
  status: string;
  description: string;
}

interface NodeConfigOptions {
  network: string;
  eventName: string;
  contractABI: string;
  triggerType: string;
  contractAddress: string;
}

export class WorkflowEvent {
  private _workflow: Workflow;

  constructor(options: WorkflowEventOptions) {
    if (!(options?.nodes?.length > 0)) {
      throw new Error(
        "WorkflowEvent requires options with a non-empty nodes array",
      );
    }
    this._workflow = new Workflow({ ...options, node: options.nodes[0] });
  }

  get workflow(): Workflow {
    return this._workflow;
  }

  get id(): string | undefined {
    return this._workflow?.id;
  }

  get name(): string | undefined {
    return this._workflow?.name;
  }

  get contractAddress(): string | undefined {
    return this._workflow?.node?.data?.config?.contractAddress;
  }

  get contractABI(): string | undefined {
    return this._workflow?.node?.data?.config?.contractABI;
  }

  getParsedABI(): any[] {
    return this._workflow?.node?.data?.config?.getParsedABI() || [];
  }

  get chain(): string | undefined {
    return this._workflow?.node?.data?.config?.network;
  }

  get eventName(): string | undefined {
    return this._workflow?.node?.data?.config?.eventName;
  }

  hasConfigurationChanged(newEvent: WorkflowEventOptions): any[] | undefined {
    return diff(this, new WorkflowEvent(newEvent));
  }
}

export class Workflow {
  id: string;
  name: string;
  userId: string;
  organizationId: string;
  enabled: boolean;
  node: Node;

  constructor({
    id,
    name,
    userId,
    organizationId,
    enabled,
    node,
  }: WorkflowOptions) {
    this.id = id;
    this.name = name;
    this.userId = userId;
    this.organizationId = organizationId;
    this.enabled = enabled;
    this.node = new Node(node);
  }
}

export class Node {
  id: string;
  data: NodeData;
  type: string;
  selected: boolean;

  constructor({ id, data, type, selected }: NodeOptions) {
    this.id = id;
    this.data = new NodeData(data);
    this.type = type;
    this.selected = selected;
  }
}

export class NodeData {
  type: string;
  label: string;
  config: NodeConfig;
  status: string;
  description: string;

  constructor({ type, label, config, status, description }: NodeDataOptions) {
    this.type = type;
    this.label = label;
    this.config = new NodeConfig(config);
    this.status = status;
    this.description = description;
  }
}

export class NodeConfig {
  network: string;
  eventName: string;
  contractABI: string;
  triggerType: string;
  contractAddress: string;

  constructor({
    network,
    eventName,
    contractABI,
    triggerType,
    contractAddress,
  }: NodeConfigOptions) {
    this.network = network;
    this.eventName = eventName;
    this.contractABI = contractABI;
    this.triggerType = triggerType;
    this.contractAddress = contractAddress;
  }

  getParsedABI(): any[] {
    try {
      return JSON.parse(this.contractABI);
    } catch (_error) {
      return [];
    }
  }
}

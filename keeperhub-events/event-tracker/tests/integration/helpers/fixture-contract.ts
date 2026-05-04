import { ethers } from "ethers";
import solc from "solc";

const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract EventEmitter {
    event Emitted(address indexed sender, uint256 value);

    function emitEvent(uint256 value) external {
        emit Emitted(msg.sender, value);
    }
}
`;

export interface CompiledContract {
  abi: unknown[];
  bytecode: string;
}

export interface DeployedFixture {
  address: string;
  abi: unknown[];
  contract: ethers.Contract;
}

let cached: CompiledContract | null = null;

export function compileEventEmitter(): CompiledContract {
  if (cached) {
    return cached;
  }
  const input = {
    language: "Solidity",
    sources: { "EventEmitter.sol": { content: SOURCE } },
    settings: {
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    contracts?: Record<
      string,
      Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>
    >;
    errors?: { severity: string; formattedMessage: string }[];
  };

  const fatal = (output.errors ?? []).filter((e) => e.severity === "error");
  if (fatal.length > 0) {
    throw new Error(
      `solc compile failed:\n${fatal.map((e) => e.formattedMessage).join("\n")}`,
    );
  }

  const artifact = output.contracts?.["EventEmitter.sol"]?.EventEmitter;
  if (!artifact) {
    throw new Error("EventEmitter artifact missing from solc output");
  }

  cached = {
    abi: artifact.abi,
    bytecode: `0x${artifact.evm.bytecode.object}`,
  };
  return cached;
}

export async function deployEventEmitter(
  wallet: ethers.Wallet,
): Promise<DeployedFixture> {
  const { abi, bytecode } = compileEventEmitter();
  const factory = new ethers.ContractFactory(
    abi as ethers.InterfaceAbi,
    bytecode,
    wallet,
  );
  const deployed = await factory.deploy();
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  return { address, abi, contract: deployed as ethers.Contract };
}

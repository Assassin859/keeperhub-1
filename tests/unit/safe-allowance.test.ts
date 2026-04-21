import { ethers } from "ethers";
import { describe, expect, it } from "vitest";
import { ZERO_ADDRESS } from "@/lib/safe/address";
import {
  ALLOWANCE_MODULE_ABI,
  buildAddDelegateCalldata,
  buildDeleteAllowanceCalldata,
  buildEnableModuleCalldata,
  buildExecTransactionCalldata,
  buildPreValidatedSignature,
  buildSetAllowanceCalldata,
  decodeTokenAllowance,
  SAFE_EXEC_ABI,
  SAFE_OPERATION_CALL,
  SENTINEL_MODULES,
} from "@/lib/safe/allowance-module";

const OWNER = "0x1111111111111111111111111111111111111111";
const MODULE = "0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const DELEGATE = "0x2222222222222222222222222222222222222222";
const UINT96_MAX = BigInt(2) ** BigInt(96) - BigInt(1);
const RESET_TIME_RANGE_RE = /resetTimeMinutes must fit in uint16/i;
const ALLOWANCE_RANGE_RE = /allowanceAmount must fit in uint96/i;

const safeInterface = new ethers.Interface(SAFE_EXEC_ABI);
const allowanceInterface = new ethers.Interface(ALLOWANCE_MODULE_ABI);

describe("buildEnableModuleCalldata", () => {
  it("starts with the enableModule selector", () => {
    const selector = safeInterface.getFunction("enableModule")?.selector;
    expect(selector).toBeDefined();
    const data = buildEnableModuleCalldata(MODULE);
    expect(data.slice(0, 10)).toBe(selector);
  });

  it("round-trips the module address through the encoder", () => {
    const data = buildEnableModuleCalldata(MODULE);
    const decoded = safeInterface.decodeFunctionData("enableModule", data);
    expect(ethers.getAddress(decoded[0])).toBe(ethers.getAddress(MODULE));
  });
});

describe("buildAddDelegateCalldata", () => {
  it("encodes the delegate address", () => {
    const data = buildAddDelegateCalldata(DELEGATE);
    const decoded = allowanceInterface.decodeFunctionData("addDelegate", data);
    expect(ethers.getAddress(decoded[0])).toBe(ethers.getAddress(DELEGATE));
  });
});

describe("buildSetAllowanceCalldata", () => {
  it("encodes delegate, token, amount, and period correctly", () => {
    const amount = BigInt(1_000_000);
    const period = 1440;
    const data = buildSetAllowanceCalldata({
      delegate: DELEGATE,
      token: TOKEN,
      allowanceAmount: amount,
      resetTimeMinutes: period,
    });
    const decoded = allowanceInterface.decodeFunctionData("setAllowance", data);
    expect(ethers.getAddress(decoded[0])).toBe(ethers.getAddress(DELEGATE));
    expect(ethers.getAddress(decoded[1])).toBe(ethers.getAddress(TOKEN));
    expect(decoded[2]).toBe(amount);
    expect(decoded[3]).toBe(BigInt(period));
    expect(decoded[4]).toBe(BigInt(0));
  });

  it("rejects resetTimeMinutes above uint16 range", () => {
    expect(() =>
      buildSetAllowanceCalldata({
        delegate: DELEGATE,
        token: TOKEN,
        allowanceAmount: BigInt(1),
        resetTimeMinutes: 0xff_ff + 1,
      })
    ).toThrow(RESET_TIME_RANGE_RE);
  });

  it("rejects allowance above uint96 range", () => {
    expect(() =>
      buildSetAllowanceCalldata({
        delegate: DELEGATE,
        token: TOKEN,
        allowanceAmount: UINT96_MAX + BigInt(1),
        resetTimeMinutes: 1440,
      })
    ).toThrow(ALLOWANCE_RANGE_RE);
  });
});

describe("buildDeleteAllowanceCalldata", () => {
  it("encodes delegate and token", () => {
    const data = buildDeleteAllowanceCalldata({
      delegate: DELEGATE,
      token: TOKEN,
    });
    const decoded = allowanceInterface.decodeFunctionData(
      "deleteAllowance",
      data
    );
    expect(ethers.getAddress(decoded[0])).toBe(ethers.getAddress(DELEGATE));
    expect(ethers.getAddress(decoded[1])).toBe(ethers.getAddress(TOKEN));
  });
});

describe("buildPreValidatedSignature", () => {
  it("returns exactly 65 bytes", () => {
    const sig = buildPreValidatedSignature(OWNER);
    expect(ethers.dataLength(sig)).toBe(65);
  });

  it("encodes the owner in the first 32 bytes, zero s, v=1", () => {
    const sig = buildPreValidatedSignature(OWNER);
    const r = ethers.dataSlice(sig, 0, 32);
    const s = ethers.dataSlice(sig, 32, 64);
    const v = ethers.dataSlice(sig, 64, 65);
    expect(ethers.getAddress(ethers.dataSlice(r, 12, 32))).toBe(
      ethers.getAddress(OWNER)
    );
    expect(BigInt(s)).toBe(BigInt(0));
    expect(v).toBe("0x01");
  });
});

describe("buildExecTransactionCalldata", () => {
  it("wraps an arbitrary inner call with zero gas fields and pre-validated sig", () => {
    const inner = buildSetAllowanceCalldata({
      delegate: DELEGATE,
      token: TOKEN,
      allowanceAmount: BigInt(500),
      resetTimeMinutes: 1440,
    });
    const outer = buildExecTransactionCalldata({
      to: MODULE,
      data: inner,
      ownerAddress: OWNER,
    });

    const decoded = safeInterface.decodeFunctionData("execTransaction", outer);
    expect(ethers.getAddress(decoded.to)).toBe(ethers.getAddress(MODULE));
    expect(decoded.value).toBe(BigInt(0));
    expect(decoded.data).toBe(inner);
    expect(decoded.operation).toBe(BigInt(SAFE_OPERATION_CALL));
    expect(decoded.safeTxGas).toBe(BigInt(0));
    expect(decoded.baseGas).toBe(BigInt(0));
    expect(decoded.gasPrice).toBe(BigInt(0));
    expect(ethers.getAddress(decoded.gasToken)).toBe(ZERO_ADDRESS);
    expect(ethers.getAddress(decoded.refundReceiver)).toBe(ZERO_ADDRESS);
    expect(ethers.dataLength(decoded.signatures)).toBe(65);
  });
});

describe("decodeTokenAllowance", () => {
  it("unpacks the module's uint256[5] into labelled fields", () => {
    const raw: readonly [bigint, bigint, bigint, bigint, bigint] = [
      BigInt(1_000_000),
      BigInt(250_000),
      BigInt(1440),
      BigInt(27_789_000),
      BigInt(3),
    ];
    const decoded = decodeTokenAllowance(raw);
    expect(decoded.amount).toBe(BigInt(1_000_000));
    expect(decoded.spent).toBe(BigInt(250_000));
    expect(decoded.resetTimeMinutes).toBe(1440);
    expect(decoded.lastResetMinutes).toBe(27_789_000);
    expect(decoded.nonce).toBe(BigInt(3));
  });
});

describe("SENTINEL_MODULES", () => {
  it("matches Safe's documented sentinel address", () => {
    expect(SENTINEL_MODULES.toLowerCase()).toBe(
      "0x0000000000000000000000000000000000000001"
    );
  });
});

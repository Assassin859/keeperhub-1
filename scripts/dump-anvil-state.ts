/**
 * Dump a running anvil instance's committed state to a file that
 * `anvil --load-state` accepts.
 *
 * anvil_dumpState returns a hex-encoded gzip blob, but --load-state
 * only parses the decompressed SerializableState JSON (verified
 * empirically: the raw blob is rejected with "expected struct
 * SerializableState"), so this decodes before writing.
 *
 * The dump contains only state committed by transactions on the fork:
 * eth_call warms nothing, while storage slots merely read (SLOAD) by an
 * executed transaction are included with their upstream values. See the
 * snapshot notes in scripts/protocol-local.sh.
 *
 * Usage: tsx scripts/dump-anvil-state.ts <rpc-url> <out-file>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

type JsonRpcResponse = {
  result?: string;
  error?: { code: number; message: string };
};

async function main(): Promise<void> {
  const [rpcUrl, outFile] = process.argv.slice(2);
  if (!(rpcUrl && outFile)) {
    process.stderr.write(
      "usage: tsx scripts/dump-anvil-state.ts <rpc-url> <out-file>\n"
    );
    process.exit(2);
  }
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "anvil_dumpState",
      params: [],
    }),
  });
  const body = (await response.json()) as JsonRpcResponse;
  if (!body.result?.startsWith("0x")) {
    throw new Error(
      `anvil_dumpState failed: ${JSON.stringify(body.error ?? body)}`
    );
  }
  const state = gunzipSync(Buffer.from(body.result.slice(2), "hex"));
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, state);
  process.stdout.write(
    `wrote ${outFile}: ${state.length} bytes decoded from a ${(body.result.length - 2) / 2}-byte blob\n`
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});

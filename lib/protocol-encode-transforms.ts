/**
 * Protocol Encode Transform Registry
 *
 * Stores pre-ABI-encoding transform functions keyed by protocol/action/input.
 * Applied in step handlers after collecting user values, before reshapeArgsForAbi.
 *
 * Transforms are NOT serializable (they are functions). They live here,
 * separate from ProtocolActionInput, so the MCP schemas endpoint and
 * other serialization layers are unaffected.
 */

type EncodeTransform = (value: string) => string;

type TransformKey = string;

function makeKey(
  protocolSlug: string,
  actionSlug: string,
  inputName: string
): TransformKey {
  return `${protocolSlug}/${actionSlug}/${inputName}`;
}

const transforms = new Map<TransformKey, EncodeTransform>();

export function registerEncodeTransform(
  protocolSlug: string,
  actionSlug: string,
  inputName: string,
  transform: EncodeTransform
): void {
  transforms.set(makeKey(protocolSlug, actionSlug, inputName), transform);
}

export function getEncodeTransform(
  protocolSlug: string,
  actionSlug: string,
  inputName: string
): EncodeTransform | undefined {
  return transforms.get(makeKey(protocolSlug, actionSlug, inputName));
}

export function applyEncodeTransformsNamed(
  protocolSlug: string,
  actionSlug: string,
  inputs: Array<{ name: string; value: string }>
): Array<{ name: string; value: string }> {
  if (transforms.size === 0) {
    return inputs;
  }

  return inputs.map((input) => {
    const transform = transforms.get(
      makeKey(protocolSlug, actionSlug, input.name)
    );
    if (transform) {
      return { name: input.name, value: transform(input.value) };
    }
    return input;
  });
}

export function clearEncodeTransforms(): void {
  transforms.clear();
}

// -- Built-in transforms ------------------------------------------------------
// Registered eagerly here (not in protocol definition files) because the
// workflow bundler tree-shakes side-effect imports from "use step" files.
// Protocol definition modules are imported via `import "@/protocols"` which
// may not survive bundling, so transforms declared there would be missing
// at runtime.

function padAddressToBytes(value: string): string {
  if (value.startsWith("{{")) {
    return value;
  }
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  return `0x${hex.padStart(64, "0")}`;
}

registerEncodeTransform(
  "chainlink",
  "ccip-get-fee",
  "receiver",
  padAddressToBytes
);
registerEncodeTransform(
  "chainlink",
  "ccip-send",
  "receiver",
  padAddressToBytes
);

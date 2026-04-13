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

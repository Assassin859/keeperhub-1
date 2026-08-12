type JsonRpcMessage = Record<string, unknown>;

function normalizeMessage(message: unknown): unknown {
  if (
    !message ||
    typeof message !== "object" ||
    (message as JsonRpcMessage).method !== "tools/call"
  ) {
    return message;
  }

  const params = (message as JsonRpcMessage).params;
  if (!params || typeof params !== "object") {
    return message;
  }

  const args = (params as JsonRpcMessage).arguments;
  if (args !== null && args !== undefined) {
    return message;
  }

  return {
    ...(message as JsonRpcMessage),
    params: { ...(params as JsonRpcMessage), arguments: {} },
  };
}

/**
 * A `tools/call` sent with `arguments` omitted or explicitly `null` fails the
 * SDK's `z.record().optional()` params schema with a raw Zod error, which the
 * transport surfaces as -32603 (Internal error) rather than a validation
 * error. That reads as "the server is down" on exactly the call an agent is
 * most likely to make first: a tool with no required parameters, invoked
 * with no arguments object at all. Defaulting to `{}` here, before the
 * request reaches the SDK, keeps every per-tool schema (e.g.
 * get_wallet_integration's required `integrationId`) enforced downstream
 * unchanged.
 */
export function normalizeToolCallArguments(body: unknown): unknown {
  return Array.isArray(body)
    ? body.map(normalizeMessage)
    : normalizeMessage(body);
}

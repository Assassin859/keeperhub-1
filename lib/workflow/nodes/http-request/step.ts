/**
 * Executable step function for HTTP Request action
 */
import "server-only";

import { safeFetch } from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import { extractTemplateTokens } from "@/lib/utils/template";
import {
  type StepInput,
  withStepLogging,
} from "@/lib/workflow/executor/step-handler";

type HttpRequestResult =
  | { success: true; data: unknown; status: number }
  | { success: false; error: string; status?: number };

export type HttpRequestInput = StepInput & {
  endpoint: string;
  httpMethod: string;
  httpHeaders?: string;
  httpBody?: string;
};

// URLs never legitimately contain `{{`, so any token left in the endpoint
// after template processing is a user-config bug we surface clearly instead
// of forwarding to fetch as a malformed URL.
function findUnresolvedTemplateVariables(value: string): string[] {
  return [...new Set(extractTemplateTokens(value))];
}

/**
 * Validate the rendered endpoint string before any network IO. Trims
 * surrounding whitespace and rejects unresolved `{{var}}` template tokens
 * (which usually mean a missing trigger payload field). Exported for tests.
 */
export type EndpointValidation =
  | { ok: true; endpoint: string }
  | { ok: false; error: string };

export function validateHttpRequestEndpoint(
  rawEndpoint: string | undefined | null
): EndpointValidation {
  const endpoint = rawEndpoint?.trim();
  if (!endpoint) {
    return { ok: false, error: "HTTP request failed: URL is required" };
  }
  const unresolved = findUnresolvedTemplateVariables(endpoint);
  if (unresolved.length > 0) {
    return {
      ok: false,
      error: `HTTP request failed: Missing template variable(s) in URL: ${unresolved.join(", ")}`,
    };
  }
  return { ok: true, endpoint };
}

function parseHeaders(httpHeaders?: string): Record<string, string> {
  if (!httpHeaders) {
    return {};
  }
  try {
    return JSON.parse(httpHeaders);
  } catch {
    return {};
  }
}

function parseBody(httpMethod: string, httpBody?: string): string | undefined {
  if (httpMethod === "GET" || !httpBody) {
    return;
  }
  try {
    const parsedBody = JSON.parse(httpBody);
    return Object.keys(parsedBody).length > 0
      ? JSON.stringify(parsedBody)
      : undefined;
  } catch {
    const trimmed = httpBody.trim();
    return trimmed && trimmed !== "{}" ? httpBody : undefined;
  }
}

function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

/**
 * HTTP request logic
 */
async function httpRequest(
  input: HttpRequestInput
): Promise<HttpRequestResult> {
  const validation = validateHttpRequestEndpoint(input.endpoint);
  if (!validation.ok) {
    return { success: false, error: validation.error };
  }
  const { endpoint } = validation;

  try {
    const response = await safeFetch(endpoint, {
      method: input.httpMethod,
      headers: parseHeaders(input.httpHeaders),
      body: parseBody(input.httpMethod, input.httpBody),
      plugin: "http-request",
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      return {
        success: false,
        error: `HTTP request failed with status ${response.status}: ${errorText}`,
        status: response.status,
      };
    }

    const data = await parseResponse(response);
    return { success: true, data, status: response.status };
  } catch (error) {
    return {
      success: false,
      error: `HTTP request failed: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * HTTP Request Step
 * Makes an HTTP request to an endpoint
 */
// biome-ignore lint/suspicious/useAwait: workflow "use step" requires async
export async function httpRequestStep(
  input: HttpRequestInput
): Promise<HttpRequestResult> {
  "use step";
  return withStepLogging(input, () => httpRequest(input));
}
httpRequestStep.maxRetries = 0;

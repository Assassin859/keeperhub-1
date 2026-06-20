/**
 * Etherscan API v2 integration
 *
 * Provides ABI fetching, source code metadata, and transaction listing
 * for Ethereum, Base, Arbitrum, and other Etherscan-supported chains.
 */

type EtherscanResponse = {
  status: string;
  message: string;
  result: string;
};

type EtherscanSourceCodeResponse = {
  status: string;
  message: string;
  result: Array<{
    Proxy?: string;
    Implementation?: string;
    ABI?: string;
    ContractName?: string;
    Facets?: string;
    IsDiamond?: string;
    [key: string]: unknown;
  }>;
};

export type AbiResult = {
  success: boolean;
  abi?: unknown[];
  error?: string;
};

export type SourceCodeResult = {
  success: boolean;
  isProxy?: boolean;
  isDiamond?: boolean;
  implementationAddress?: string;
  facetAddresses?: string[];
  contractName?: string;
  proxyAbi?: string;
  error?: string;
};

/**
 * Fetch ABI from Etherscan API v2
 *
 * @param apiUrl - Base API URL (e.g., "https://api.etherscan.io/v2/api")
 * @param chainId - Chain ID for the request
 * @param contractAddress - Contract address to fetch ABI for
 * @param apiKey - Optional Etherscan API key (recommended for rate limits)
 */
export async function fetchEtherscanAbi(
  apiUrl: string,
  chainId: number,
  contractAddress: string,
  apiKey?: string
): Promise<AbiResult> {
  const params = new URLSearchParams({
    chainid: chainId.toString(),
    module: "contract",
    action: "getabi",
    address: contractAddress,
  });

  if (apiKey) {
    params.set("apikey", apiKey);
  }

  try {
    const response = await fetch(`${apiUrl}?${params}`);
    const data: EtherscanResponse = await response.json();

    if (data.status !== "1") {
      // Parse common Etherscan error messages
      const errorMessage = parseEtherscanError(data.result || data.message);
      return {
        success: false,
        error: errorMessage,
      };
    }

    const abi = JSON.parse(data.result);
    return { success: true, abi };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Fetch source code and proxy metadata from Etherscan API v2
 *
 * @param apiUrl - Base API URL (e.g., "https://api.etherscan.io/v2/api")
 * @param chainId - Chain ID for the request
 * @param contractAddress - Contract address to fetch source code for
 * @param apiKey - Optional Etherscan API key (recommended for rate limits)
 */
export async function fetchEtherscanSourceCode(
  apiUrl: string,
  chainId: number,
  contractAddress: string,
  apiKey?: string
): Promise<SourceCodeResult> {
  const params = new URLSearchParams({
    chainid: chainId.toString(),
    module: "contract",
    action: "getsourcecode",
    address: contractAddress,
  });

  if (apiKey) {
    params.set("apikey", apiKey);
  }

  try {
    const response = await fetch(`${apiUrl}?${params}`);
    const data: EtherscanSourceCodeResponse = await response.json();

    if (data.status !== "1") {
      const errorMessage = parseEtherscanError(
        data.message || "Failed to fetch source code"
      );
      return {
        success: false,
        error: errorMessage,
      };
    }

    if (!data.result || data.result.length === 0) {
      return {
        success: false,
        error: "No source code data returned from Etherscan",
      };
    }

    const contractData = data.result[0];
    const isProxy = contractData.Proxy === "1";
    const isDiamond = contractData.IsDiamond === "1";
    const implementationAddress = contractData.Implementation;
    const contractName = contractData.ContractName;

    // Parse facet addresses if this is a Diamond contract
    let facetAddresses: string[] | undefined;
    if (isDiamond && contractData.Facets) {
      facetAddresses = contractData.Facets.split(",")
        .map((addr) => addr.trim())
        .filter((addr) => addr.length > 0);
    }

    return {
      success: true,
      isProxy,
      isDiamond,
      implementationAddress: implementationAddress || undefined,
      facetAddresses,
      contractName: contractName || undefined,
      proxyAbi: contractData.ABI || undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export type EtherscanTransaction = {
  hash: string;
  from: string;
  to: string;
  value: string;
  input: string;
  blockNumber: string;
  timeStamp: string;
  isError: string;
  functionName: string;
};

type EtherscanTxListResponse = {
  status: string;
  message: string;
  result: EtherscanTransaction[] | string;
};

// Etherscan caps txlist at 10,000 records per query and rejects any page
// where page * offset > 10,000. A smaller offset keeps every page within that
// window so pagination actually reaches all 10,000 records instead of being
// stuck on page 1.
const ETHERSCAN_TX_OFFSET = 2000;
const MAX_PAGES = 5;
const ETHERSCAN_PAGE_DELAY_MS = 220;

type TxPageResult =
  | { done: false; transactions: EtherscanTransaction[] }
  | { done: true; transactions: EtherscanTransaction[] }
  | { error: string };

function buildTxListParams(
  apiUrl: string,
  chainId: number,
  contractAddress: string,
  startBlock: number,
  endBlock: number,
  page: number,
  apiKey?: string
): string {
  const params = new URLSearchParams({
    chainid: chainId.toString(),
    module: "account",
    action: "txlist",
    address: contractAddress,
    startblock: startBlock.toString(),
    endblock: endBlock.toString(),
    page: page.toString(),
    offset: ETHERSCAN_TX_OFFSET.toString(),
    // Most-recent-first: the 10,000-record cap then keeps the newest
    // transactions in range rather than the oldest, which is what history
    // lookbacks want and avoids silently dropping recent activity.
    sort: "desc",
  });

  if (apiKey) {
    params.set("apikey", apiKey);
  }

  return `${apiUrl}?${params}`;
}

function isEmptyTxListResult(data: EtherscanTxListResponse): boolean {
  if (Array.isArray(data.result) && data.result.length === 0) {
    return true;
  }
  if (typeof data.result !== "string") {
    return false;
  }
  const lower = data.result.toLowerCase();
  return (
    lower.includes("no transactions found") ||
    lower.includes("no records found")
  );
}

// Etherscan returns this once page * offset exceeds 10,000. It marks the end of
// the reachable window, so stop paginating and keep what was already collected
// rather than failing the whole fetch and discarding earlier pages.
function isWindowExhausted(data: EtherscanTxListResponse): boolean {
  const message = typeof data.result === "string" ? data.result : data.message;
  return (message ?? "").toLowerCase().includes("result window is too large");
}

function parseTxListResponse(data: EtherscanTxListResponse): TxPageResult {
  if (data.status !== "1") {
    if (isEmptyTxListResult(data) || isWindowExhausted(data)) {
      return { done: true, transactions: [] };
    }
    const errorMessage = parseEtherscanError(
      typeof data.result === "string" ? data.result : data.message
    );
    return { error: errorMessage };
  }

  if (!Array.isArray(data.result)) {
    return { done: true, transactions: [] };
  }

  const hasMore = data.result.length >= ETHERSCAN_TX_OFFSET;
  return { done: !hasMore, transactions: data.result };
}

/**
 * Fetch transaction list for a contract address from Etherscan API v2
 *
 * Uses the `account` module `txlist` action to get normal transactions.
 * Paginates automatically (max 10,000 per page, up to MAX_PAGES pages).
 *
 * @param apiUrl - Base API URL (e.g., "https://api.etherscan.io/v2/api")
 * @param chainId - Chain ID for the request
 * @param contractAddress - Contract address to list transactions for
 * @param startBlock - Start block number
 * @param endBlock - End block number
 * @param apiKey - Optional Etherscan API key (recommended for rate limits)
 */
export async function fetchEtherscanTransactions(
  apiUrl: string,
  chainId: number,
  contractAddress: string,
  startBlock: number,
  endBlock: number,
  apiKey?: string
): Promise<
  | { success: true; transactions: EtherscanTransaction[] }
  | { success: false; error: string }
> {
  const allTransactions: EtherscanTransaction[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (page > 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, ETHERSCAN_PAGE_DELAY_MS)
      );
    }

    const url = buildTxListParams(
      apiUrl,
      chainId,
      contractAddress,
      startBlock,
      endBlock,
      page,
      apiKey
    );

    try {
      const response = await fetch(url);
      const data: EtherscanTxListResponse = await response.json();
      const result = parseTxListResponse(data);

      if ("error" in result) {
        return { success: false, error: result.error };
      }

      allTransactions.push(...result.transactions);

      if (result.done) {
        break;
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error fetching transactions",
      };
    }
  }

  return { success: true, transactions: allTransactions };
}

/**
 * Parse Etherscan error messages into user-friendly messages
 */
function parseEtherscanError(message: string): string {
  const lowerMessage = message.toLowerCase();

  if (lowerMessage.includes("contract source code not verified")) {
    return "Contract source code is not verified on the block explorer";
  }

  if (lowerMessage.includes("invalid api key")) {
    return "Invalid Etherscan API key";
  }

  if (lowerMessage.includes("rate limit")) {
    return "Rate limit exceeded. Please try again later.";
  }

  if (lowerMessage.includes("invalid address")) {
    return "Invalid contract address";
  }

  return message || "Failed to fetch ABI from Etherscan";
}

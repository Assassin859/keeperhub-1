/**
 * The AI agent crawlers and fetchers this deployment explicitly welcomes.
 *
 * Lives here rather than in app/robots.ts because two consumers need it: the
 * generated robots.txt, and anyone writing the matching edge rule. A user-agent
 * allowed in robots.txt but refused by bot management is worse than either
 * alone - the crawler is told it may fetch, then gets a 403, and its operator
 * has no way to tell a policy decision from an outage.
 */
export const AGENT_CRAWLER_USER_AGENTS: readonly string[] = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "DeepSeekBot",
  "Applebot-Extended",
  "Meta-ExternalAgent",
  "Bytespider",
  "cohere-ai",
  "YouBot",
  "ora-agent",
];

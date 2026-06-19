export const LEDGER_SCHEMA = "panda-burn.agent-usage-ledger.v1";
export const LEDGER_DIR = "data/agent-usage";
export const PRICING_VERSION = "api-equivalent-estimate-2026-06-v2";
export const PARSER_VERSION = "usage-jsonl-parser-2026-06-v6";
export const DEFAULT_DIMENSION_LIMIT = 500;
export const HIGH_CARDINALITY_DIMENSION_LIMIT = 500;

export const TOKEN_KEYS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation_5m_input_tokens",
  "cache_creation_1h_input_tokens",
  "cache_read_input_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

export const COST_KEYS = [
  "input_usd",
  "cached_input_usd",
  "cache_creation_usd",
  "cache_read_usd",
  "output_usd",
  "total_usd",
];

export const PRICING = [
  price("openai", /gpt-5\.5-pro|gpt-5-pro|gpt-5\.5/i, "gpt-5.5", 5, 0.5, 0, 0, 30),
  price("openai", /gpt-5\.4-mini/i, "gpt-5.4-mini", 0.75, 0.075, 0, 0, 4.5),
  price("openai", /gpt-5\.4/i, "gpt-5.4", 2.5, 0.25, 0, 0, 15),
  price("anthropic", /claude-fable/i, "claude-fable", 10, 1, 12.5, 1, 50, 20),
  price("anthropic", /claude-mythos/i, "claude-mythos", 10, 1, 12.5, 1, 50, 20),
  price("anthropic", /claude-opus/i, "claude-opus", 5, 0.5, 6.25, 0.5, 25, 10),
  price("anthropic", /claude-sonnet/i, "claude-sonnet", 3, 0.3, 3.75, 0.3, 15, 6),
  price("anthropic", /claude-haiku/i, "claude-haiku", 1, 0.1, 1.25, 0.1, 5, 2),
];

function price(provider, pattern, label, input, cachedInput, cacheCreation, cacheRead, output, cacheCreation1h = cacheCreation) {
  return { provider, pattern, label, input, cachedInput, cacheCreation, cacheCreation1h, cacheRead, output };
}

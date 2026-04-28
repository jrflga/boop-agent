// Anthropic Claude pricing in USD per million tokens. Update when prices change.
// Used to compute savedUsd estimates (cache read vs uncached input). costUsd
// itself comes from the SDK's msg.total_cost_usd, so this table is only for the
// "you saved $X by caching" calculation.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

const PRICES: Record<string, ModelPrice> = {
  // Sonnet family (claude-sonnet-4-6, claude-sonnet-4-6-YYYYMMDD)
  "claude-sonnet-4-6": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  // Opus family (claude-opus-4-7, claude-opus-4-7-YYYYMMDD)
  "claude-opus-4-7": {
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  // Haiku family (claude-haiku-4-5, claude-haiku-4-5-YYYYMMDD)
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
};

const DEFAULT_PRICE: ModelPrice = PRICES["claude-sonnet-4-6"];

export function priceFor(model: string): ModelPrice {
  // Direct hit
  if (PRICES[model]) return PRICES[model];
  // Prefix match: SDK appends -YYYYMMDD to date-stamped variants
  for (const key of Object.keys(PRICES)) {
    if (model.startsWith(key)) return PRICES[key];
  }
  return DEFAULT_PRICE;
}

/** Estimate the dollars saved by reading from cache vs paying full input rate. */
export function savedFromCacheRead(model: string, cacheReadTokens: number): number {
  const p = priceFor(model);
  const savedPerMTok = p.inputPerMTok - p.cacheReadPerMTok;
  return (cacheReadTokens * savedPerMTok) / 1_000_000;
}

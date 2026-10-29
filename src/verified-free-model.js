// Explicit supplier promotion, verified against official docs and an inert tool probe.
// A zero typed into an arbitrary provider's price table is never approval.
export const FREE_MODEL = 'reflection/beam:free';
export const FREE_ENDPOINT = 'https://api.commandcode.ai/alpha';
export function verifiedFreeQuote(p) {
  return p?.endpoint === FREE_ENDPOINT && p.model === FREE_MODEL &&
    p.prices?.reasoningIncluded === true &&
    ['inputCnyPerMillion', 'cacheHitCnyPerMillion', 'outputCnyPerMillion'].every(k => p.prices[k] === 0);
}

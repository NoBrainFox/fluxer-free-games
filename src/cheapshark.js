// Thin CheapShark client. Responses are cached in memory so on-demand commands
// never hit the API more often than the cache TTL allows.

const BASE = (process.env.CHEAPSHARK_URL || 'https://www.cheapshark.com').replace(/\/$/, '');
const API = `${BASE}/api/1.0`;
const USER_AGENT = 'fluxer-freegames-bot/1.0 (+https://www.cheapshark.com)';

const STORES_TTL_MS = 24 * 60 * 60 * 1000;
const DEALS_TTL_MS = 10 * 60 * 1000;
const MAX_PAGES = 5;

let storesCache = { at: 0, stores: [] };
const dealsCache = new Map();

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`CheapShark rate limited the request${retryAfter ? `, retry after ${retryAfter}s` : ''}`);
  }
  if (!res.ok) throw new Error(`CheapShark ${res.status} ${res.statusText} for ${url}`);
  return { data: await res.json(), headers: res.headers };
}

export function assetUrl(path) {
  if (!path) return undefined;
  return path.startsWith('http') ? path : `${BASE}${path}`;
}

export function dealUrl(dealID) {
  return `${BASE}/redirect?dealID=${encodeURIComponent(dealID)}`;
}

export async function getStores() {
  if (Date.now() - storesCache.at < STORES_TTL_MS && storesCache.stores.length) return storesCache.stores;
  const { data } = await getJson(`${API}/stores`);
  storesCache = { at: Date.now(), stores: data.filter((store) => store.isActive === 1) };
  return storesCache.stores;
}

// Turns a list of store IDs or (partial, case-insensitive) names into store objects.
export function resolveStores(stores, wanted) {
  if (wanted.some((entry) => entry.toLowerCase() === 'all')) return { matched: stores, unknown: [] };
  const matched = [];
  const unknown = [];
  for (const entry of wanted) {
    const needle = entry.toLowerCase();
    const store =
      stores.find((s) => s.storeID === entry) ??
      stores.find((s) => s.storeName.toLowerCase() === needle) ??
      stores.find((s) => s.storeName.toLowerCase().includes(needle));
    if (store) {
      if (!matched.includes(store)) matched.push(store);
    } else {
      unknown.push(entry);
    }
  }
  return { matched, unknown };
}

// Returns deals whose current price is 0 for the given store IDs.
export async function getFreeDeals(storeIds, { includeFreeToPlay = false, fresh = false } = {}) {
  const key = `${[...storeIds].sort().join(',')}|${includeFreeToPlay}`;
  const cached = dealsCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < DEALS_TTL_MS) return cached.deals;

  const deals = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      upperPrice: '0',
      pageSize: '60',
      pageNumber: String(page),
      sortBy: 'Recent',
    });
    if (storeIds.length) params.set('storeID', storeIds.join(','));
    const { data, headers } = await getJson(`${API}/deals?${params}`);
    deals.push(...data);
    const totalPages = Number.parseInt(headers.get('x-total-page-count') ?? '1', 10);
    if (data.length === 0 || page + 1 >= totalPages) break;
  }

  // Keep only games that are free right now; free-to-play titles (normal price 0) are optional.
  const free = deals.filter((deal) => {
    if (Number.parseFloat(deal.salePrice) !== 0) return false;
    return includeFreeToPlay || Number.parseFloat(deal.normalPrice) > 0;
  });

  dealsCache.set(key, { at: Date.now(), deals: free });
  return free;
}

// CheapShark has no end date for deals, so look it up elsewhere: Epic's own
// free-games feed (exact) and GamerPower's giveaway list (best effort).

const EPIC_URL = 'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=en-US';
const GAMERPOWER_URL = 'https://www.gamerpower.com/api/giveaways?type=game';
const CACHE_TTL_MS = 30 * 60 * 1000;

const caches = new Map();

// Lowercase, drop bracketed parts, trademark signs, "giveaway" and punctuation.
export function normalizeTitle(title) {
  return String(title)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[™®©]/g, '')
    .replace(/\b(giveaway|free)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function cached(key, url, parse) {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const value = parse(await res.json());
    caches.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn(`[enddates] could not load ${key}: ${err.message}`);
    // Keep using stale data rather than nothing, and don't retry on every deal.
    caches.set(key, { at: Date.now(), value: hit?.value ?? [] });
    return hit?.value ?? [];
  }
}

// Epic marks a free promotion with discountPercentage 0 (the share of the price you pay).
export function parseEpic(json) {
  const elements = json?.data?.Catalog?.searchStore?.elements ?? [];
  const result = [];
  for (const element of elements) {
    for (const group of element.promotions?.promotionalOffers ?? []) {
      for (const offer of group.promotionalOffers ?? []) {
        if (offer.discountSetting?.discountPercentage === 0 && offer.endDate) {
          result.push({ title: normalizeTitle(element.title), endsAt: new Date(offer.endDate), source: 'epic' });
        }
      }
    }
  }
  return result;
}

// GamerPower dates look like "2026-10-30 23:59:00" with no timezone; treated as UTC.
export function parseGamerPower(json) {
  if (!Array.isArray(json)) return [];
  return json
    .filter((g) => g.end_date && g.end_date !== 'N/A' && g.status !== 'Expired')
    .map((g) => ({
      title: normalizeTitle(g.title),
      platforms: String(g.platforms ?? '').toLowerCase(),
      endsAt: new Date(`${g.end_date.replace(' ', 'T')}Z`),
      source: 'gamerpower',
    }))
    .filter((g) => !Number.isNaN(g.endsAt.getTime()));
}

function storeMatches(platforms, storeName) {
  const store = storeName.toLowerCase();
  if (store.includes('epic')) return platforms.includes('epic');
  return platforms.includes(store);
}

// Returns { endsAt: Date, source: 'epic' | 'gamerpower' } or null.
export async function findEndDate(title, storeName = '') {
  const wanted = normalizeTitle(title);
  if (!wanted) return null;
  const now = Date.now();
  const upcoming = (entry) => entry.title === wanted && entry.endsAt.getTime() > now;

  if (storeName.toLowerCase().includes('epic')) {
    const epic = (await cached('Epic free games', EPIC_URL, parseEpic)).find(upcoming);
    if (epic) return epic;
  }
  const giveaways = (await cached('GamerPower giveaways', GAMERPOWER_URL, parseGamerPower)).filter(upcoming);
  return giveaways.find((g) => storeMatches(g.platforms, storeName)) ?? giveaways[0] ?? null;
}

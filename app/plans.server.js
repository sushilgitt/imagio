// Plan tier catalog + resolution.
//
// This app is a Shopify "Managed Pricing" app: the actual plans (and their real
// prices/trials) are created in the Partner Dashboard, and a merchant subscribes
// to one on Shopify's hosted pricing page. The app cannot create charges; its job
// is to read the *name* of the merchant's active subscription and map it to the
// tier defined here — which decides how large a catalog the plan covers and
// which features are unlocked.
//
// Plans are priced by catalog size (`maxProducts`), not by images processed:
// within its product limit a shop can compress, restyle and caption freely. The
// one feature with a real per-image cost — background removal through a paid
// API — has its own monthly allowance (`monthlyBgRemovals`).
//
// IMPORTANT: the plan names below (and their "<name> Annual" variants) MUST match
// the plan names created in the Partner Dashboard exactly, because tier resolution
// is by name. `getPlanByName` normalizes case and a trailing " Annual" and falls
// back to the Free tier for unknown / missing names.

// Feature flags used for gating. Only list features that actually exist in the
// app — the billing page renders these as the plan's inclusions, so a flag for
// an unbuilt feature would advertise something merchants can't use.
export const FEATURES = [
  "optimize",      // WebP compression / replace
  "altText",       // AI alt text
  "studio",        // crop, padding and background for consistent photos
  "bgRemoval",     // AI background removal inside the studio
  "autoOptimize",  // background auto-optimize new products
];

function feat(...enabled) {
  const set = new Set(enabled);
  return Object.fromEntries(FEATURES.map((f) => [f, set.has(f)]));
}

// Tier catalog, cheapest → most expensive. `tier` is the stable internal key;
// `name` is the human/Partner-Dashboard plan name used for resolution.
export const PLANS = [
  {
    tier: "free",
    name: "Free",
    price: 0,
    priceAnnual: 0,
    maxProducts: 25,
    monthlyBgRemovals: 0,
    features: feat("optimize"),
  },
  {
    tier: "shop",
    name: "Shop",
    price: 12,
    priceAnnual: 120,
    maxProducts: 250,
    monthlyBgRemovals: 0,
    features: feat("optimize", "altText", "studio"),
  },
  {
    tier: "brand",
    name: "Brand",
    price: 29,
    priceAnnual: 290,
    maxProducts: 2000,
    monthlyBgRemovals: 200,
    features: feat("optimize", "altText", "studio", "bgRemoval", "autoOptimize"),
  },
  {
    tier: "catalog",
    name: "Catalog",
    price: 79,
    priceAnnual: 790,
    maxProducts: 20000,
    monthlyBgRemovals: 1000,
    features: feat("optimize", "altText", "studio", "bgRemoval", "autoOptimize"),
  },
];

export const FREE_PLAN = PLANS[0];

// Resolve a Shopify subscription name to a tier. Strips a trailing " Annual"
// (so "Brand Annual" → "Brand") and matches case-insensitively. Falls back to
// the Free tier when the name is missing or unrecognized — so an installed-but-
// not-yet-subscribed shop still has a usable (limited) plan.
export function getPlanByName(name) {
  if (!name) return FREE_PLAN;
  const base = String(name).replace(/\s+annual$/i, "").trim().toLowerCase();
  return PLANS.find((p) => p.name.toLowerCase() === base) || FREE_PLAN;
}

// Boolean feature gate. Safe with a null/undefined plan (treated as Free).
export function entitled(plan, feature) {
  const p = plan || FREE_PLAN;
  return Boolean(p.features?.[feature]);
}

// Cheapest plan that covers `productCount` products (the upgrade suggestion).
export function planForCatalog(productCount) {
  return PLANS.find((p) => p.maxProducts >= productCount) || PLANS[PLANS.length - 1];
}

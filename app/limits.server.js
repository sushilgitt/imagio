// Catalog-size limits. Plans are priced by how many products a shop has: a
// shop whose catalog fits its plan can use every feature the plan includes; a
// shop that has outgrown it keeps the audit, restore and renaming (they cost us
// nothing and never lock a merchant out of their own photos) but can't start
// new compression, studio or AI work until it upgrades.
import { getBillingStateCached } from "./billing.server";
import { FREE_PLAN, planForCatalog } from "./plans.server";

// productsCount is cheap, but every page and action asks for it — cache briefly.
const countCache = new Map(); // shop -> { count, expires }
const COUNT_TTL_MS = 5 * 60 * 1000;

export async function getProductCount(admin, shop) {
  const hit = countCache.get(shop);
  if (hit && hit.expires > Date.now()) return hit.count;
  const res = await admin.graphql(
    `#graphql
      query CatalogSize {
        productsCount(limit: null) { count }
      }`
  );
  const json = await res.json();
  const count = json.data?.productsCount?.count ?? 0;
  countCache.set(shop, { count, expires: Date.now() + COUNT_TTL_MS });
  return count;
}

// { plan, productCount, maxProducts, withinLimit, suggestedPlan }.
// A re-auth Response propagates; any other billing failure falls back to Free.
export async function getPlanStatus(admin, shop) {
  let plan = FREE_PLAN;
  try {
    plan = (await getBillingStateCached(admin, shop)).plan || FREE_PLAN;
  } catch (e) {
    if (e instanceof Response) throw e;
  }
  const productCount = await getProductCount(admin, shop);
  const withinLimit = productCount <= plan.maxProducts;
  return {
    plan,
    productCount,
    maxProducts: plan.maxProducts,
    withinLimit,
    suggestedPlan: withinLimit ? null : planForCatalog(productCount).name,
  };
}

// Message for actions refused because the catalog outgrew the plan.
export function overLimitMessage(status) {
  return `Your store has ${status.productCount.toLocaleString()} products and the ${status.plan.name} plan `
    + `covers ${status.maxProducts.toLocaleString()}. Upgrade to ${status.suggestedPlan} to keep going — `
    + `restore and SEO rename still work.`;
}

// products/create webhook — background "set & forget" auto-optimization.
//
// When a merchant on a plan that includes autoOptimize (Brand+) has the toggle
// enabled, every newly created product gets its images optimized automatically.
//
// Shopify expects a fast ACK (a slow webhook is retried / disabled), and image
// optimization is heavy, so we acknowledge immediately and run the work
// out-of-band. Work is serialized per shop (a simple in-process promise chain)
// so a bulk import doesn't stampede the optimizer or drop products. This is
// sufficient for the single long-running Node instance on Coolify; a durable job
// queue (e.g. Redis/BullMQ) would be the hardening follow-up for multi-instance.
//
// We deliberately subscribe to products/create only (not products/update), so the
// media replacement performed during optimization can't re-trigger this webhook.
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";
import { entitled } from "../plans.server";
import { getPlanStatus } from "../limits.server";
import { optimizeBatch } from "../optimize.server";
import { studioBatch, parseStyle, bgRemovalConfigured } from "../studio.server";
import { getBgRemovalsLeft } from "../usage.server";

// Per-shop sequential task queue. Tasks chain off the previous one so products
// created in quick succession are processed in order rather than concurrently.
const queues = new Map(); // shop -> Promise (tail of the chain)

function enqueue(shop, task) {
  const prev = queues.get(shop) || Promise.resolve();
  const next = prev
    .then(task)
    .catch((e) => console.error("[AUTO-OPT]", shop, e?.message || e));
  queues.set(shop, next);
  // Drop the map entry once the chain drains (only if no newer task replaced it).
  next.finally(() => {
    if (queues.get(shop) === next) queues.delete(shop);
  });
}

async function runAutoOptimize(shop, productGid) {
  // Cheapest gate first: skip entirely unless the merchant turned this on.
  const settings = await db.shopSettings.findUnique({ where: { shop } });
  if (!settings?.autoOptimize) return;

  // Offline admin client (uses the stored offline access token for the shop).
  const { admin } = await unauthenticated.admin(shop);

  const status = await getPlanStatus(admin, shop);
  if (!entitled(status.plan, "autoOptimize")) return; // plan changed since toggle was set
  if (!status.withinLimit) return; // catalog outgrew the plan
  const genAlt = entitled(status.plan, "altText"); // Brand/Catalog always include alt text

  // With a saved studio style, restyle the new product (the studio output is
  // already compressed); otherwise just compress it. The 70-iteration ceiling
  // is a safety backstop (250 images / studio batch of 4).
  if (settings.autoStudio && settings.studioStyle && entitled(status.plan, "studio")) {
    const style = parseStyle(settings.studioStyle);
    if (style.removeBg && !(entitled(status.plan, "bgRemoval") && bgRemovalConfigured())) style.removeBg = false;
    // Decide once: switching style mid-product would restyle earlier photos again.
    if (style.removeBg && (await getBgRemovalsLeft(shop, status.plan)) <= 0) style.removeBg = false;
    for (let i = 0; i < 70; i++) {
      const bgRemovalsLeft = style.removeBg ? await getBgRemovalsLeft(shop, status.plan) : 0;
      const res = await studioBatch(admin, productGid, style, { shop, bgRemovalsLeft, genAlt });
      if (!res.success || res.done || !res.advanced) break; // includes allowance running out
    }
    return;
  }

  for (let i = 0; i < 50; i++) {
    const res = await optimizeBatch(admin, productGid, { shop, genAlt });
    if (!res.success || res.done || !res.advanced) break;
  }
}

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const productGid =
    payload?.admin_graphql_api_id ||
    (payload?.id ? `gid://shopify/Product/${payload.id}` : null);

  if (productGid) {
    enqueue(shop, () => runAutoOptimize(shop, productGid));
  }

  // ACK immediately — the optimization runs in the background.
  return new Response();
};

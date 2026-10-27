// Per-shop monthly usage metering.
//
// Counters are keyed by shop + period ("YYYY-MM"), so a fresh row is created at
// the start of every month and the previous month's counts are preserved for
// reference. `imagesUsed` is informational (plans are priced by catalog size);
// `bgRemovals` is enforced against the plan's monthlyBgRemovals.
import db from "./db.server";
import { FREE_PLAN } from "./plans.server";

// Current month as "YYYY-MM" (UTC). A new period string each month means a new
// counter row, which is how usage "resets".
export function currentPeriod() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// Read this shop's usage for the current period without creating a row (a
// missing row means zero used). Returns { period, imagesUsed, bgRemovals }.
export async function getUsage(shop) {
  const period = currentPeriod();
  const row = await db.usageCounter.findUnique({
    where: { shop_period: { shop, period } },
  });
  return { period, imagesUsed: row?.imagesUsed ?? 0, bgRemovals: row?.bgRemovals ?? 0 };
}

// Atomically add `n` to one of this shop's current-period counters, creating
// the row on first use. No-op for n <= 0. Returns the new total.
async function increment(shop, field, n) {
  if (!n || n <= 0) return (await getUsage(shop))[field];
  const period = currentPeriod();
  const row = await db.usageCounter.upsert({
    where: { shop_period: { shop, period } },
    create: { shop, period, [field]: n },
    update: { [field]: { increment: n } },
  });
  return row[field];
}

export function incrementUsage(shop, n) {
  return increment(shop, "imagesUsed", n);
}

export function incrementBgRemovals(shop, n) {
  return increment(shop, "bgRemovals", n);
}

// Background removals this shop may still run this month under `plan` (>= 0).
export async function getBgRemovalsLeft(shop, plan) {
  const allowance = (plan || FREE_PLAN).monthlyBgRemovals;
  const { bgRemovals } = await getUsage(shop);
  return Math.max(0, allowance - bgRemovals);
}

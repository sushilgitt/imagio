// Photo Studio (server only): makes a product's photos consistent — same shape,
// same padding, same background — and optionally cuts the product out of its
// background with an AI service first.
//
// The output is a WebP that replaces the photo on the product through the same
// swap as compression (finalizeReplacements), so order, featured image and
// variant images are kept, and every restyled photo gets a record pointing at
// the photo it replaced — Restore follows that chain back to the original.
//
// studioBatch handles ONE batch per call; the caller loops until { done }.
// A photo counts as done when its current record carries the same style key,
// so re-running with a new style restyles everything, and re-running with the
// same style is a no-op.
import sharp from "sharp";
import {
  timedFetch, mapLimit, uploadOptimizedImage, commitReplacements, deleteFiles, dropRecords,
  variantOptionsByMedia, seoBaseName, writeSummary, generateAIAltText,
} from "./optimize.server";
import { incrementBgRemovals, incrementUsage } from "./usage.server";

export const STUDIO_BATCH_SIZE = 4;
const MAX_SIDE = 2048;

export const RATIOS = {
  "1:1": [1, 1],
  "4:5": [4, 5],
  "3:4": [3, 4],
  keep: null,
};

export const DEFAULT_STYLE = { ratio: "1:1", background: "#ffffff", padding: 6, trim: true, removeBg: false };

// Normalize untrusted input (form data / stored JSON) into a valid style.
export function parseStyle(raw) {
  let s = raw;
  if (typeof raw === "string") {
    try { s = JSON.parse(raw); } catch { s = {}; }
  }
  s = s || {};
  const background = /^#[0-9a-f]{6}$/i.test(s.background || "") ? s.background.toLowerCase() : DEFAULT_STYLE.background;
  const padding = Math.min(20, Math.max(0, Math.round(Number(s.padding ?? DEFAULT_STYLE.padding)) || 0));
  return {
    ratio: Object.hasOwn(RATIOS, s.ratio) ? s.ratio : DEFAULT_STYLE.ratio,
    background,
    padding,
    trim: s.trim === undefined ? DEFAULT_STYLE.trim : Boolean(s.trim),
    removeBg: Boolean(s.removeBg),
  };
}

export function styleKey(style) {
  return [style.ratio, style.background, style.padding, style.trim ? 1 : 0, style.removeBg ? 1 : 0].join("|");
}

/* -------------------------------------------------------------------------- */
/*  Background removal                                                        */
/* -------------------------------------------------------------------------- */

// Photoroom is preferred when both keys are configured.
export function bgRemovalConfigured() {
  return Boolean(process.env.PHOTOROOM_API_KEY || process.env.REMOVE_BG_API_KEY);
}

// Returns a PNG with a transparent background.
async function removeBackground(buffer) {
  const form = new FormData();
  form.append("image_file", new Blob([buffer]), "photo.png");
  let res;
  if (process.env.PHOTOROOM_API_KEY) {
    res = await timedFetch("https://sdk.photoroom.com/v1/segment", {
      method: "POST",
      headers: { "x-api-key": process.env.PHOTOROOM_API_KEY },
      body: form,
    }, 60000);
  } else if (process.env.REMOVE_BG_API_KEY) {
    form.append("size", "auto");
    form.append("format", "png");
    res = await timedFetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": process.env.REMOVE_BG_API_KEY },
      body: form,
    }, 60000);
  } else {
    throw new Error("Background removal is not configured");
  }
  if (!res.ok) throw new Error(`Background removal HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

// Apply `style` to an image buffer. Returns a WebP buffer, at most
// `maxSide` px on the long side. Never enlarges the product itself — a small
// photo gets a proportionally small canvas rather than a blurry upscale.
export async function renderStyled(input, style, maxSide = MAX_SIDE) {
  let buffer = await sharp(input).rotate().png().toBuffer();
  if (style.removeBg) buffer = await removeBackground(buffer);

  let subject = sharp(buffer);
  if (style.trim) {
    // Trims edges matching the corner colour (or transparency after removal).
    // A photo that is all one colour can't be trimmed — keep it as is.
    try {
      buffer = await sharp(buffer).trim({ threshold: 12 }).png().toBuffer();
      subject = sharp(buffer);
    } catch { /* nothing to trim */ }
  }
  const { width: w, height: h } = await subject.metadata();

  const [rw, rh] = RATIOS[style.ratio] || [w, h];
  const pad = style.padding / 100;
  const inner = 1 - 2 * pad;

  // Largest canvas allowed for this ratio, then the subject's room inside it.
  const maxW = rw >= rh ? maxSide : Math.round(maxSide * (rw / rh));
  const maxH = rh >= rw ? maxSide : Math.round(maxSide * (rh / rw));
  const scale = Math.min(1, (maxW * inner) / w, (maxH * inner) / h);
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));

  // Canvas just big enough for the scaled subject plus padding, at the ratio.
  let cw = Math.max(sw / inner, (sh / inner) * (rw / rh));
  let ch = cw * (rh / rw);
  cw = Math.min(maxW, Math.round(cw));
  ch = Math.min(maxH, Math.round(ch));

  const left = Math.max(0, Math.floor((cw - sw) / 2));
  const top = Math.max(0, Math.floor((ch - sh) / 2));
  const resized = await subject.resize(sw, sh).png().toBuffer();

  return sharp({ create: { width: cw, height: ch, channels: 3, background: style.background } })
    .composite([{ input: resized, left, top }])
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}

async function download(url) {
  const res = await timedFetch(url, {}, 25000);
  if (!res.ok) throw new Error(`Fetch image HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Before/after preview of one photo, as a data URL (small, for the page only).
export async function previewStyled(imageUrl, style) {
  const out = await renderStyled(await download(imageUrl), style, 640);
  return `data:image/webp;base64,${out.toString("base64")}`;
}

/* -------------------------------------------------------------------------- */
/*  Batch                                                                     */
/* -------------------------------------------------------------------------- */

// opts:
//   shop           — when set, restyled photos are counted via incrementUsage
//   bgRemovalsLeft — background removals this call may use (capped + metered)
//   genAlt         — write AI alt text for photos missing it (Shop+ plans)
export async function studioBatch(admin, productId, style, opts = {}) {
  const { shop = null, bgRemovalsLeft = 0, genAlt = false } = opts;
  const key = styleKey(style);

  const response = await admin.graphql(
    `#graphql
      query StudioProductMedia($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          media(first: 250) {
            nodes { id ... on MediaImage { image { url altText } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            nodes { key value }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const json = await response.json();
  const product = json.data?.product;
  if (!product) return { success: false, error: "Product not found", productId };

  const mediaOrder = product.media.nodes.map((n) => n.id);
  const images = product.media.nodes
    .filter((n) => n?.image?.url)
    .map((n) => ({ id: n.id, url: n.image.url, altText: n.image.altText }));
  const total = images.length;

  // Current record per photo on the product (see optimizeBatch).
  const live = new Map();
  for (const node of product.metafields.nodes) {
    if (!node.key.startsWith("image_")) continue;
    const id = `gid://shopify/MediaImage/${node.key.slice("image_".length)}`;
    if (!mediaOrder.includes(id)) continue;
    try { live.set(id, JSON.parse(node.value)); } catch { /* ignore malformed */ }
  }

  const pending = images.filter((img) => live.get(img.id)?.studio !== key);
  if (pending.length === 0) {
    return { success: true, productId, title: product.title, total, styled: total, done: true, advanced: false,
      message: `"${product.title}" already uses this style` };
  }
  if (style.removeBg && bgRemovalsLeft <= 0) {
    return { success: false, productId, bgLimit: true,
      error: "This month's background removals are used up. Turn off background removal or upgrade your plan." };
  }

  const cap = style.removeBg ? Math.min(STUDIO_BATCH_SIZE, bgRemovalsLeft) : STUDIO_BATCH_SIZE;
  const batch = pending.slice(0, cap);
  const options = await variantOptionsByMedia(admin, productId);

  // Photos that are already Imagio copies are restyled from the merchant's
  // original (full quality, no old padding baked in), and the new record
  // points straight at that original — so chains never grow past one step.
  // If the original is gone from Files, fall back to the copy and chain to it.
  const roots = batch
    .map((img) => live.get(img.id))
    .filter((rec) => rec?.status === "optimized" && rec.originalImageId)
    .map((rec) => rec.originalImageId);
  const rootUrl = new Map();
  if (roots.length > 0) {
    const res = await admin.graphql(
      `#graphql
        query StudioOriginals($ids: [ID!]!) {
          nodes(ids: $ids) { ... on MediaImage { id status image { url } } }
        }`,
      { variables: { ids: roots } }
    );
    const json = await res.json();
    for (const n of json.data?.nodes || []) {
      if (n?.status === "READY" && n.image?.url) rootUrl.set(n.id, n.image.url);
    }
  }

  let bgAttempts = 0;
  const results = (await mapLimit(batch, 2, async (image) => {
    try {
      const prev = live.get(image.id);
      const root = prev?.status === "optimized" ? prev.originalImageId : null;
      const fromOriginal = Boolean(root && rootUrl.has(root));
      const input = await download(fromOriginal ? rootUrl.get(root) : image.url);
      if (style.removeBg) bgAttempts += 1;
      const out = await renderStyled(input, style);
      const position = images.findIndex((i) => i.id === image.id) + 1;
      const baseName = seoBaseName(product.handle, position, options.get(image.id));
      let altText = image.altText || "";
      if (genAlt && altText.length < 10) altText = await generateAIAltText(image.url, product.title);
      const newId = await uploadOptimizedImage(admin, out, altText, baseName);
      // Savings are measured against the merchant's original, not the copy.
      const originalSizeMB = prev?.originalSizeMB ?? input.byteLength / (1024 * 1024);
      const optimizedSizeMB = out.byteLength / (1024 * 1024);
      return {
        key: `image_${newId.split("/").pop()}`,
        replacement: { oldId: image.id, newId },
        // The copy this replaces, deleted once the swap is in: { id, key }.
        superseded: fromOriginal ? { id: image.id, key: `image_${image.id.split("/").pop()}` } : null,
        record: {
          status: "optimized",
          kind: "studio",
          studio: key,
          originalSizeMB,
          optimizedSizeMB,
          compressionRate: originalSizeMB > 0
            ? Math.max(0, Math.round(((originalSizeMB - optimizedSizeMB) / originalSizeMB) * 100))
            : 0,
          altText,
          optimizedAt: new Date().toISOString(),
          originalImageId: fromOriginal ? root : image.id,
          newImageId: newId,
        },
      };
    } catch (err) {
      console.error(`[STUDIO] ${image.id}:`, err?.message || err);
      return null;
    }
  })).filter(Boolean);

  // Background removals are paid when they run, whether or not the swap lands.
  if (shop && bgAttempts > 0) {
    try { await incrementBgRemovals(shop, bgAttempts); }
    catch (e) { console.error("[USAGE] bg removal increment failed:", e?.message || e); }
  }

  const { kept, error: commitError } = await commitReplacements(admin, productId, results, mediaOrder, "STUDIO");
  if (commitError) return { success: false, productId, error: `Could not save progress on "${product.title}": ${commitError}` };

  // Old copies that were restyled from the original are now off the product
  // and no longer part of any chain — remove them and their records.
  const superseded = kept.map((r) => r.superseded).filter(Boolean);
  if (superseded.length > 0) {
    await deleteFiles(admin, superseded.map((x) => x.id));
    await dropRecords(admin, productId, superseded.map((x) => x.key));
  }

  if (shop && kept.length > 0) {
    try { await incrementUsage(shop, kept.length); }
    catch (e) { console.error("[USAGE] studio increment failed:", e?.message || e); }
  }

  // Summary over the records now current on the product.
  const replaced = new Set(kept.map((r) => r.replacement.oldId));
  const current = [
    ...[...live.entries()].filter(([id]) => !replaced.has(id)).map(([, rec]) => rec),
    ...kept.map((r) => r.record),
  ];
  await writeSummary(admin, productId, total, current);

  const styled = total - pending.length + kept.length;
  return {
    success: true,
    productId,
    title: product.title,
    total,
    styled,
    advanced: kept.length > 0,
    done: styled >= total,
    bgRemovalsUsed: bgAttempts,
    batchFailures: batch.length - kept.length,
    message: styled >= total
      ? `Restyled "${product.title}" — ${total}/${total} photos`
      : `Restyling "${product.title}" — ${styled}/${total} photos`,
  };
}

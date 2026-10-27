// Image-optimization pipeline (server only).
//
// Extracted from app/routes/app.Productoptimization.jsx so it can be shared by
// both the interactive optimizer route AND the background products/create
// webhook. Everything here runs server-side (uses sharp + node DNS).
//
// optimizeBatch processes ONE batch of a product's images per call and persists
// per-image + summary metafields. Callers loop it until { done: true }.
//
// Every replacement (compression here, restyling in studio.server.js) writes a
// record `image_<new media id>` = { originalImageId, newImageId, … }, so the
// records form a chain from the photo on the product back to the merchant's
// original — which is what restoreProduct follows.
import sharp from "sharp";
import { setDefaultResultOrder } from "node:dns";
import { incrementUsage } from "./usage.server";

/* -------------------------------------------------------------------------- */
/*  Networking helpers                                                        */
/* -------------------------------------------------------------------------- */

// The container was hanging ~10s per image on IPv6 connect attempts to the
// Shopify CDN (ConnectTimeoutError to 2620:127:f00e::). Prefer IPv4 so fetch
// connects to the reachable address first, and cap every CDN request with an
// explicit timeout so a single bad fetch can never stall the loader or a batch.
let dnsConfigured = false;
function preferIPv4() {
  if (dnsConfigured) return;
  try { setDefaultResultOrder("ipv4first"); } catch { /* older runtimes */ }
  dnsConfigured = true;
}

export async function timedFetch(url, opts = {}, timeoutMs = 20000) {
  preferIPv4();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Run async `fn` over `items` with at most `limit` in flight at once.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Cheaply measure an image's size in MB via a HEAD request (no body download).
export async function headSizeMB(url) {
  try {
    const res = await timedFetch(url, { method: "HEAD" }, 8000);
    if (!res.ok) return 0;
    const cl = res.headers.get("content-length");
    return cl ? parseInt(cl, 10) / (1024 * 1024) : 0;
  } catch {
    return 0;
  }
}

export const BATCH_SIZE = 6;          // images optimized per batch call
export const BATCH_CONCURRENCY = 6;   // images processed in parallel within a batch

/* -------------------------------------------------------------------------- */
/*  Optimization primitives                                                   */
/* -------------------------------------------------------------------------- */

// Download + compress one image with Sharp. Always re-encodes to WebP, which
// reliably beats JPEG/PNG (typically 25-40% smaller at q80). Retries the
// download once to ride out transient CDN blips.
export async function optimizeImage(imageUrl) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await timedFetch(imageUrl, {}, 25000);
      if (!response.ok) throw new Error(`Fetch image HTTP ${response.status}`);
      const originalBuffer = Buffer.from(await response.arrayBuffer());
      const originalSizeMB = originalBuffer.byteLength / (1024 * 1024);

      const optimizedBuffer = await sharp(originalBuffer)
        .rotate() // honor EXIF orientation before stripping metadata
        .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();

      const optimizedSizeMB = optimizedBuffer.byteLength / (1024 * 1024);
      return {
        originalSizeMB,
        optimizedSizeMB,
        optimizedBuffer,
        compressionRate: originalSizeMB > 0
          ? Math.round(((originalSizeMB - optimizedSizeMB) / originalSizeMB) * 100)
          : 0,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/* -------------------------------------------------------------------------- */
/*  SEO file names                                                            */
/* -------------------------------------------------------------------------- */

const MAX_NAME_LENGTH = 80; // before the extension

function slugify(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Search-friendly base name for a product photo: product handle, then the
// option values of the variant that shows it (e.g. "navy"), then its 1-based
// position — "linen-shirt-navy-2". Position keeps names unique per product,
// and handles are unique per shop, so names don't collide in Files.
export function seoBaseName(handle, position, optionValues = []) {
  const parts = [slugify(handle) || "product"];
  for (const v of optionValues) {
    const s = slugify(v);
    if (s && s !== "default-title" && !parts.includes(s)) parts.push(s);
  }
  const suffix = `-${position}`;
  const base = parts.join("-").slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/, "");
  return `${base}${suffix}`;
}

// MediaImage id -> option values of the variants showing it. Budget:
// 1 + variants(2 + 100 × (selectedOptions 1 + media 3)) ≈ 403.
export async function variantOptionsByMedia(admin, productId) {
  const res = await admin.graphql(
    `#graphql
      query VariantOptions($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            nodes { selectedOptions { value } media(first: 1) { nodes { id } } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const json = await res.json();
  const byMedia = new Map();
  for (const v of json.data?.product?.variants?.nodes || []) {
    const mediaId = v.media?.nodes?.[0]?.id;
    if (!mediaId) continue;
    const values = byMedia.get(mediaId) || [];
    for (const o of v.selectedOptions || []) if (!values.includes(o.value)) values.push(o.value);
    byMedia.set(mediaId, values);
  }
  // A photo shared by several variants only keeps the values they all have in
  // common (e.g. "navy" across navy/S, navy/M) — a size would mislabel it.
  for (const v of json.data?.product?.variants?.nodes || []) {
    const mediaId = v.media?.nodes?.[0]?.id;
    if (!mediaId) continue;
    const mine = (v.selectedOptions || []).map((o) => o.value);
    byMedia.set(mediaId, byMedia.get(mediaId).filter((x) => mine.includes(x)));
  }
  return byMedia;
}

// "https://cdn.shopify.com/s/files/…/Linen_Shirt.JPG?v=1" -> { name: "Linen_Shirt", ext: "jpg" }
function fileNameFromUrl(url) {
  const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
  const dot = last.lastIndexOf(".");
  return dot > 0
    ? { name: last.slice(0, dot), ext: last.slice(dot + 1).toLowerCase() }
    : { name: last, ext: "" };
}

// Give every photo on a product its SEO name, in place — no re-encoding and no
// plan limits. Keeps each file's extension; photos already named correctly are
// left alone. Returns { success, productId, renamed, total, message }.
export async function renameProductImages(admin, productId) {
  const res = await admin.graphql(
    `#graphql
      query RenameProductMedia($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          media(first: 250) { nodes { id ... on MediaImage { image { url } } } }
        }
      }`,
    { variables: { id: productId } }
  );
  const json = await res.json();
  const product = json.data?.product;
  if (!product) return { success: false, error: "Product not found", productId };

  const images = product.media.nodes.filter((n) => n?.image?.url);
  const options = await variantOptionsByMedia(admin, productId);
  const current = images.map((img) => fileNameFromUrl(img.image.url));
  const files = [];
  images.forEach((img, i) => {
    const { name, ext } = current[i];
    const target = seoBaseName(product.handle, i + 1, options.get(img.id));
    if (name !== target) files.push({ id: img.id, filename: ext ? `${target}.${ext}` : target });
  });

  // After the merchant reorders photos, two of them can want each other's
  // names. Move those through a temporary name first so neither collides.
  const taken = new Set(current.map((c) => (c.ext ? `${c.name}.${c.ext}` : c.name)));
  const swaps = files.filter((f) => taken.has(f.filename));
  const passes = [
    swaps.map((f) => ({ id: f.id, filename: f.filename.replace(/(\.[^.]+)?$/, `-${Date.now()}$1`) })),
    files,
  ];

  // A name can also be taken by a file elsewhere in the store (Shopify keeps
  // file names unique). When a chunk fails, retry its files one by one and
  // skip just the ones that clash.
  const failed = new Set();
  let lastErr = null;
  for (const pass of passes) {
    for (let i = 0; i < pass.length; i += 25) {
      const chunk = pass.slice(i, i + 25).filter((f) => !failed.has(f.id));
      if ((await updateFiles(admin, chunk)) === null) continue;
      for (const f of chunk) {
        const err = await updateFiles(admin, [f]);
        if (err) { failed.add(f.id); lastErr = err; }
      }
    }
  }
  const renamed = files.filter((f) => !failed.has(f.id)).length;
  if (renamed === 0 && failed.size > 0) {
    return { success: false, productId, error: `Could not rename photos on "${product.title}": ${lastErr}` };
  }

  return {
    success: true,
    productId,
    title: product.title,
    renamed,
    skipped: failed.size,
    total: images.length,
    message: failed.size > 0
      ? `Renamed ${renamed} photo(s) on "${product.title}" — ${failed.size} skipped because the name is already used by another file`
      : files.length > 0
        ? `Renamed ${files.length} photo(s) on "${product.title}"`
        : `Photos on "${product.title}" already have SEO names`,
  };
}

// Upload the optimized buffer via a Shopify staged upload and register it as a
// new file (MediaImage). Returns the new MediaImage gid. The file is NOT yet on
// the product — finalizeReplacements attaches it once Shopify has processed it.
// `baseName` is the file name without extension (see seoBaseName).
export async function uploadOptimizedImage(admin, optimizedBuffer, altText, baseName = `imagio-${Date.now()}`) {
  const isWebP = optimizedBuffer[8] === 0x57 && optimizedBuffer[9] === 0x45;
  const mimeType = isWebP ? "image/webp" : "image/jpeg";
  const filename = `${baseName}.${isWebP ? "webp" : "jpg"}`;

  const stagedRes = await admin.graphql(
    `#graphql
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets { url resourceUrl parameters { name value } }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: [{
          filename,
          mimeType,
          httpMethod: "POST",
          resource: "IMAGE",
          fileSize: String(optimizedBuffer.byteLength),
        }],
      },
    }
  );
  const stagedData = await stagedRes.json();
  if (stagedData.data?.stagedUploadsCreate?.userErrors?.length > 0) {
    throw new Error(stagedData.data.stagedUploadsCreate.userErrors[0].message);
  }
  const target = stagedData.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new Error("Failed to create staged upload target");

  const form = new FormData();
  for (const param of target.parameters) form.append(param.name, param.value);
  form.append("file", new Blob([optimizedBuffer], { type: mimeType }), filename);
  const uploadRes = await timedFetch(target.url, { method: "POST", body: form }, 40000);
  if (!uploadRes.ok) throw new Error(`Staged upload HTTP ${uploadRes.status}`);

  const fileRes = await admin.graphql(
    `#graphql
      mutation CreateOptimizedFile($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files { id }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        files: [{ alt: altText, contentType: "IMAGE", originalSource: target.resourceUrl, filename }],
      },
    }
  );
  const fileData = await fileRes.json();
  const fileErr = fileData.errors?.[0]?.message || fileData.data?.fileCreate?.userErrors?.[0]?.message;
  if (fileErr) throw new Error(fileErr);
  const newFile = fileData.data?.fileCreate?.files?.[0];
  if (!newFile) throw new Error("Failed to create optimized file");

  return newFile.id;
}

/* -------------------------------------------------------------------------- */
/*  Swapping originals for optimized copies without disturbing the product    */
/* -------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until every new MediaImage leaves PROCESSING (or the timeout passes).
// Returns { ready: Set<id>, failed: Set<id> }. Files must be READY before
// fileUpdate can attach them to a product.
async function waitForMediaReady(admin, ids, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let pending = [...ids];
  const ready = new Set();
  const failed = new Set();
  while (pending.length > 0 && Date.now() < deadline) {
    const res = await admin.graphql(
      `#graphql
        query MediaStatus($ids: [ID!]!) {
          nodes(ids: $ids) { ... on MediaImage { id status } }
        }`,
      { variables: { ids: pending } }
    );
    const json = await res.json();
    const nodes = json.data?.nodes || [];
    pending = [];
    for (const n of nodes) {
      if (!n?.id) continue;
      if (n.status === "READY") ready.add(n.id);
      else if (n.status === "FAILED") failed.add(n.id);
      else pending.push(n.id);
    }
    if (pending.length > 0) await sleep(1000);
  }
  // Still processing after the timeout: give up on those copies this round.
  for (const id of pending) failed.add(id);
  return { ready, failed };
}

// fileUpdate wrapper; returns the first error message, or null on success.
async function updateFiles(admin, files) {
  if (files.length === 0) return null;
  const res = await admin.graphql(
    `#graphql
      mutation UpdateFileRefs($files: [FileUpdateInput!]!) {
        fileUpdate(files: $files) {
          files { id }
          userErrors { field message }
        }
      }`,
    { variables: { files } }
  );
  const json = await res.json();
  return json.errors?.[0]?.message || json.data?.fileUpdate?.userErrors?.[0]?.message || null;
}

export async function deleteFiles(admin, fileIds) {
  if (fileIds.length === 0) return;
  await admin.graphql(
    `#graphql
      mutation DeleteUnusedCopies($fileIds: [ID!]!) {
        fileDelete(fileIds: $fileIds) { deletedFileIds }
      }`,
    { variables: { fileIds } }
  );
}

// Every { variantId, mediaId } pair on a product (a variant shows at most one
// photo). Paged, so products with more than 100 variants keep all their images.
// Budget per page: 1 + variants(2 + 100 × (1 + media 3)) ≈ 403.
async function variantMediaPairs(admin, productId) {
  const pairs = [];
  let cursor = null;
  do {
    const res = await admin.graphql(
      `#graphql
        query VariantMedia($id: ID!, $cursor: String) {
          product(id: $id) {
            variants(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes { id media(first: 1) { nodes { id } } }
            }
          }
        }`,
      { variables: { id: productId, cursor } }
    );
    const json = await res.json();
    const conn = json.data?.product?.variants;
    if (!conn) throw new Error(json.errors?.[0]?.message || "Could not read variants");
    for (const v of conn.nodes) {
      const mediaId = v.media?.nodes?.[0]?.id;
      if (mediaId) pairs.push({ variantId: v.id, mediaId });
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
  return pairs;
}

// Point variants at new photos (100 pairs per call, Shopify's limit). The
// variants must not hold a photo any more — detach the old one first.
async function appendVariantMedia(admin, productId, variantMedia, tag) {
  for (let i = 0; i < variantMedia.length; i += 100) {
    const res = await admin.graphql(
      `#graphql
        mutation AttachVariantMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
          productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
            userErrors { field message }
          }
        }`,
      { variables: { productId, variantMedia: variantMedia.slice(i, i + 100) } }
    );
    const json = await res.json();
    const err = json.errors?.[0]?.message || json.data?.productVariantAppendMedia?.userErrors?.[0]?.message;
    if (err) console.error(`[${tag}] variant media for ${productId}:`, err);
  }
}

// Move each photo in `slots` ({ id, newPosition }) into place. Applying moves
// in ascending target order lands every photo correctly.
async function reorderMedia(admin, productId, slots, tag) {
  const moves = slots
    .filter((m) => m.newPosition >= 0)
    .sort((a, b) => a.newPosition - b.newPosition)
    .map((m) => ({ id: m.id, newPosition: String(m.newPosition) }));
  if (moves.length === 0) return;
  const res = await admin.graphql(
    `#graphql
      mutation RestoreMediaOrder($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          mediaUserErrors { field message }
        }
      }`,
    { variables: { id: productId, moves } }
  );
  const json = await res.json();
  const err = json.errors?.[0]?.message || json.data?.productReorderMedia?.mediaUserErrors?.[0]?.message;
  if (err) console.error(`[${tag}] reorder media for ${productId}:`, err);
}

// Replace each original with its optimized copy while keeping the product
// exactly as the merchant arranged it:
//   1. wait for Shopify to process the copies; discard any that fail (the
//      original stays on the product untouched),
//   2. attach the copies to the product,
//   3. detach the originals from this product only — the original files stay
//      in Content › Files (a backup, and still intact anywhere else they're
//      used). This also clears them from their variants,
//   4. point those variants at the copies,
//   5. move each copy into its original's position (restores order + featured image).
// Until step 3 succeeds nothing is lost: any failure before it rolls the copies
// back off the product and deletes them, leaving the product as it was.
// `replacements` is [{ oldId, newId }]; `mediaOrder` is every media id on the
// product (images, videos, models) in its original order.
// Returns the Set of oldIds whose replacement was abandoned.
export async function finalizeReplacements(admin, productId, replacements, mediaOrder) {
  const abandoned = new Set();
  if (replacements.length === 0) return abandoned;

  let good = [];
  let pairs = [];
  let attached = false;
  try {
    const { failed } = await waitForMediaReady(admin, replacements.map((r) => r.newId));
    good = replacements.filter((r) => !failed.has(r.newId));

    const attachErr = await updateFiles(admin, good.map((r) => ({ id: r.newId, referencesToAdd: [productId] })));
    if (attachErr) throw new Error(`attach copies: ${attachErr}`);
    attached = true;

    // Read which variants show an original before detaching clears them.
    pairs = good.length > 0 ? await variantMediaPairs(admin, productId) : [];

    const detachErr = await updateFiles(admin, good.map((r) => ({ id: r.oldId, referencesToRemove: [productId] })));
    if (detachErr) throw new Error(`detach originals: ${detachErr}`);
  } catch (err) {
    // Roll back: take the copies off the product (if they got on) and delete
    // them. Originals that were detached in a partial failure are put back.
    console.error(`[OPTIMIZE] swap on ${productId} failed, rolling back:`, err?.message || err);
    try {
      if (attached) {
        await updateFiles(admin, good.map((r) => ({ id: r.oldId, referencesToAdd: [productId] })));
        await updateFiles(admin, good.map((r) => ({ id: r.newId, referencesToRemove: [productId] })));
      }
      await deleteFiles(admin, replacements.map((r) => r.newId));
    } catch (e) {
      console.error(`[OPTIMIZE] rollback on ${productId}:`, e?.message || e);
    }
    for (const r of replacements) abandoned.add(r.oldId);
    return abandoned;
  }

  for (const r of replacements) if (!good.includes(r)) abandoned.add(r.oldId);
  await deleteFiles(admin, replacements.filter((r) => abandoned.has(r.oldId)).map((r) => r.newId));
  if (good.length === 0) return abandoned;

  const newIdFor = new Map(good.map((r) => [r.oldId, r.newId]));
  await appendVariantMedia(admin, productId, pairs
    .filter((p) => newIdFor.has(p.mediaId))
    .map((p) => ({ variantId: p.variantId, mediaIds: [newIdFor.get(p.mediaId)] })), "OPTIMIZE");

  // Copies were appended at the end; move each into its original's slot.
  await reorderMedia(admin, productId, good.map((r) => ({ id: r.newId, newPosition: mediaOrder.indexOf(r.oldId) })), "OPTIMIZE");

  return abandoned;
}

// Persist a batch of results and swap their copies onto the product.
// `results` is [{ key, record, replacement? }] — replacement { oldId, newId }
// when a copy was uploaded, none for photos that were only skipped.
//
// Records are written BEFORE the swap: if saving fails nothing is swapped (and
// the uploaded copies are deleted), so a copy can never reach a product
// without the record Restore needs to undo it. Records of swaps that were then
// abandoned point at copies that never reached the product; they're removed.
// Returns { kept, error } — kept are the results now in effect.
export async function commitReplacements(admin, productId, results, mediaOrder, tag = "OPTIMIZE") {
  if (results.length === 0) return { kept: [], error: null };
  const copies = results.filter((r) => r.replacement).map((r) => r.replacement);

  let saveErr = null;
  for (let i = 0; i < results.length && !saveErr; i += 25) {
    const res = await admin.graphql(
      `#graphql
        mutation CreateMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { userErrors { field message } }
        }`,
      {
        variables: {
          metafields: results.slice(i, i + 25).map((r) => ({
            ownerId: productId,
            namespace: "image_optimization",
            key: r.key,
            type: "json",
            value: JSON.stringify(r.record),
          })),
        },
      }
    );
    const json = await res.json();
    saveErr = json.errors?.[0]?.message || json.data?.metafieldsSet?.userErrors?.[0]?.message || null;
  }
  if (saveErr) {
    console.error(`[${tag}] save records for ${productId}:`, saveErr);
    await dropRecords(admin, productId, results.map((r) => r.key));
    await deleteFiles(admin, copies.map((c) => c.newId));
    return { kept: [], error: saveErr };
  }

  let abandoned;
  try {
    abandoned = await finalizeReplacements(admin, productId, copies, mediaOrder);
  } catch (err) {
    // finalizeReplacements rolls back its own failures; an exception here means
    // the state is unknown — treat every swap as abandoned so nothing builds on it.
    console.error(`[${tag}] finalize ${productId}:`, err?.message || err);
    abandoned = new Set(copies.map((c) => c.oldId));
  }
  const dropped = results.filter((r) => r.replacement && abandoned.has(r.replacement.oldId));
  if (dropped.length > 0) await dropRecords(admin, productId, dropped.map((r) => r.key));
  return { kept: results.filter((r) => !dropped.includes(r)), error: null };
}

/* -------------------------------------------------------------------------- */
/*  Restore — undo optimization, putting the original photos back             */
/* -------------------------------------------------------------------------- */

// Delete records (metafields) from a product, 25 per call. Returns the first
// error message, or null.
export async function dropRecords(admin, productId, keys) {
  let firstErr = null;
  for (let i = 0; i < keys.length; i += 25) {
    const res = await admin.graphql(
      `#graphql
        mutation DropOptimizationRecords($metafields: [MetafieldIdentifierInput!]!) {
          metafieldsDelete(metafields: $metafields) {
            userErrors { field message }
          }
        }`,
      {
        variables: {
          metafields: keys.slice(i, i + 25).map((key) => ({
            ownerId: productId, namespace: "image_optimization", key,
          })),
        },
      }
    );
    const json = await res.json();
    const err = json.errors?.[0]?.message || json.data?.metafieldsDelete?.userErrors?.[0]?.message;
    if (err && !firstErr) firstErr = err;
  }
  return firstErr;
}

// Reverse of finalizeReplacements for one product. Every "optimized" record
// remembers { originalImageId, newImageId }; the original file was only
// detached, so it is re-attached, variants are pointed back at it, it takes the
// copy's position, and the copy is deleted. Records are then removed so the
// product reads as never optimized. Usage is not refunded.
//
// Safe to re-run: records are only removed once the copies are off the
// product, and a re-run finishes a restore whose original is already back.
// Originals the merchant has since deleted from Files can't come back — those
// copies stay on the product and their records are kept.
// Returns { success, productId, restored, unavailable, message }.
export async function restoreProduct(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      query RestoreProductMedia($id: ID!) {
        product(id: $id) {
          id
          title
          media(first: 250) { nodes { id mediaContentType } }
          metafields(first: 250, namespace: "image_optimization") {
            nodes { key value }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return { success: false, error: "Product not found", productId };

  const mediaOrder = product.media.nodes.map((n) => n.id);
  const imageCount = product.media.nodes.filter((n) => n.mediaContentType === "IMAGE").length;
  const onProduct = new Set(mediaOrder);
  const records = [];
  for (const node of product.metafields.nodes) {
    if (!node.key.startsWith("image_")) continue;
    try { records.push({ key: node.key, rec: JSON.parse(node.value) }); }
    catch { records.push({ key: node.key, rec: null }); }
  }

  // Follow each copy on the product back through its records to the
  // merchant's original. (Studio collapses chains as it goes, so this is
  // normally one step; longer chains come from older data.)
  const byNew = new Map();
  for (const r of records) {
    if (r.rec?.status === "optimized" && r.rec.newImageId && r.rec.originalImageId) byNew.set(r.rec.newImageId, r);
  }
  const swaps = [];
  for (const id of mediaOrder) {
    if (!byNew.has(id)) continue;
    const keys = [];
    const between = [];
    let cur = id;
    while (byNew.has(cur) && keys.length < 20) {
      const r = byNew.get(cur);
      keys.push(r.key);
      if (cur !== id) between.push(cur);
      cur = r.rec.originalImageId;
    }
    // `back`: the original is already on the product (a restore that stopped
    // half way) — only the copy needs to come off.
    swaps.push({ keys, oldId: cur, newId: id, between, back: onProduct.has(cur) });
  }

  // Only originals that still exist in Files (and are usable) can come back.
  const toCheck = swaps.filter((s) => !s.back).map((s) => s.oldId);
  let ready = new Set();
  if (toCheck.length > 0) {
    const res = await admin.graphql(
      `#graphql
        query OriginalFiles($ids: [ID!]!) {
          nodes(ids: $ids) { ... on MediaImage { id status } }
        }`,
      { variables: { ids: toCheck } }
    );
    const json = await res.json();
    ready = new Set((json.data?.nodes || []).filter((n) => n?.status === "READY").map((n) => n.id));
  }
  const restorable = swaps.filter((s) => s.back || ready.has(s.oldId));
  const stuck = swaps.filter((s) => !restorable.includes(s));

  if (restorable.length > 0) {
    const attach = restorable.filter((s) => !s.back);
    const attachErr = await updateFiles(admin, attach.map((s) => ({ id: s.oldId, referencesToAdd: [productId] })));
    if (attachErr) {
      // Nothing has changed on the product yet — stop and leave it as it is.
      console.error(`[RESTORE] attach originals to ${productId}:`, attachErr);
      return { success: false, productId, error: `Could not restore "${product.title}": ${attachErr}` };
    }

    // Variants showing a copy — read before the copies are detached.
    const oldIdFor = new Map(restorable.map((s) => [s.newId, s.oldId]));
    const pairs = await variantMediaPairs(admin, productId);

    // Detaching the copies also clears them from their variants.
    const detachErr = await updateFiles(admin, restorable.map((s) => ({ id: s.newId, referencesToRemove: [productId] })));
    if (detachErr) {
      // Originals and copies are both on the product now. Keep every record so
      // running Restore again finishes the job (the originals count as `back`).
      console.error(`[RESTORE] detach copies from ${productId}:`, detachErr);
      return { success: false, productId, error: `Restore of "${product.title}" did not finish (${detachErr}). Run Restore again.` };
    }

    await appendVariantMedia(admin, productId, pairs
      .filter((p) => oldIdFor.has(p.mediaId))
      .map((p) => ({ variantId: p.variantId, mediaIds: [oldIdFor.get(p.mediaId)] })), "RESTORE");

    // Originals were appended at the end; move each into its copy's slot.
    await reorderMedia(admin, productId,
      attach.map((s) => ({ id: s.oldId, newPosition: mediaOrder.indexOf(s.newId) })), "RESTORE");

    // The copies are Imagio's own files; once detached, nothing needs them.
    await deleteFiles(admin, restorable.flatMap((s) => [s.newId, ...s.between]));
  }

  // Drop every record except the chains that couldn't be undone, so the
  // product shows as unoptimized (and can be processed again later).
  const keep = new Set(stuck.flatMap((s) => s.keys));
  const dropKeys = records.filter(({ key }) => !keep.has(key)).map(({ key }) => key);
  if (keep.size === 0) dropKeys.push("optimization_summary");
  const dropErr = await dropRecords(admin, productId, dropKeys);
  if (dropErr) console.error(`[RESTORE] drop records for ${productId}:`, dropErr);
  if (stuck.length > 0) {
    // The summary counts only the copies still on the product (chain heads).
    const heads = new Set(stuck.map((s) => s.keys[0]));
    await writeSummary(admin, productId, imageCount,
      records.filter(({ key }) => heads.has(key)).map(({ rec }) => rec));
  }

  return {
    success: true,
    productId,
    title: product.title,
    restored: restorable.length,
    unavailable: stuck.length,
    message: stuck.length > 0
      ? `Restored ${restorable.length} photo(s) on "${product.title}" — ${stuck.length} original(s) were deleted from Files and can't come back`
      : `Restored "${product.title}" to its original photos`,
  };
}

export async function generateAIAltText(imageUrl, productTitle) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return `${productTitle} - product image`;
  try {
    // OpenAI vision fetches the image URL itself, so no base64 download needed.
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 150,
        temperature: 0.4,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: `Generate SEO-optimized alt text for this ${productTitle} image. Include: product type, color, material, style. Describe what you actually see. Keep under 125 characters. Don't use "image of". Return only the alt text.` },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI API error ${response.status}`);
    const result = await response.json();
    let altText = (result.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").replace(/\n/g, " ");
    if (altText.length > 125) altText = altText.substring(0, 122) + "...";
    return altText || `${productTitle} - product image`;
  } catch (error) {
    console.error("Error generating AI alt text:", error);
    return `${productTitle} - product image`;
  }
}

// Recompute product totals from the parsed per-image metafield records and
// persist the optimization_summary metafield.
export async function writeSummary(admin, productId, totalImages, records) {
  const processed = records.length;
  const totalOriginalSizeMB = records.reduce((s, r) => s + (r.originalSizeMB || 0), 0);
  const totalOptimizedSizeMB = records.reduce((s, r) => s + (r.optimizedSizeMB ?? r.originalSizeMB ?? 0), 0);
  const totalSizeSavedMB = Math.max(0, totalOriginalSizeMB - totalOptimizedSizeMB);
  const compressed = records.filter(r => r.status === "optimized");
  const avgCompressionRate = compressed.length > 0
    ? Math.round(compressed.reduce((s, r) => s + (r.compressionRate || 0), 0) / compressed.length)
    : 0;

  await admin.graphql(
    `#graphql
      mutation CreateMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
    {
      variables: {
        metafields: [{
          ownerId: productId,
          namespace: "image_optimization",
          key: "optimization_summary",
          type: "json",
          value: JSON.stringify({
            totalImages,
            optimizedImages: processed,
            totalOriginalSizeMB,
            totalOptimizedSizeMB,
            totalSizeSavedMB,
            avgCompressionRate,
            lastOptimizedAt: new Date().toISOString(),
          }),
        }],
      },
    }
  );

  return { processed, totalOriginalSizeMB, totalOptimizedSizeMB, totalSizeSavedMB, avgCompressionRate };
}

/* -------------------------------------------------------------------------- */
/*  Batch — processes ONE batch per call, returns live progress               */
/* -------------------------------------------------------------------------- */

// opts:
//   shop   — when set, optimized images are counted via incrementUsage (a stat)
//   genAlt — generate AI alt text for images missing it (default true).
//            Pass false for plans without the alt-text entitlement (Free).
// Plan limits are checked by the caller (see limits.server.js).
export async function optimizeBatch(admin, productId, opts = {}) {
  const { shop = null, genAlt = true } = opts;

  // Query current media (MediaImage gids) + existing optimization metafields.
  const response = await admin.graphql(
    `#graphql
      query GetProductMedia($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          media(first: 250) {
            edges { node { id ... on MediaImage { image { url altText } } } }
          }
          metafields(first: 250, namespace: "image_optimization") {
            edges { node { key value } }
          }
        }
      }`,
    { variables: { id: productId } }
  );
  const data = await response.json();
  const product = data.data?.product;
  if (!product) return { success: false, error: "Product not found", productId };

  // Every media id in display order — reorder positions count videos/models too.
  const mediaOrder = (product.media?.edges || []).map(e => e.node?.id).filter(Boolean);
  const images = (product.media?.edges || [])
    .map(e => e.node)
    .filter(n => n && n.image && n.image.url)
    .map(n => ({ id: n.id, url: n.image.url, altText: n.image.altText }));
  const total = images.length;

  // Records for photos currently on the product, keyed by numeric media id.
  // Records of copies that were since replaced again (e.g. a compressed copy
  // restyled in the Studio) are history kept for Restore, not current state.
  const onProduct = new Set(images.map(img => img.id.split("/").pop()));
  const records = [];
  const doneIds = new Set();
  for (const e of product.metafields.edges) {
    if (!e.node.key.startsWith("image_")) continue;
    const id = e.node.key.slice("image_".length);
    if (!onProduct.has(id)) continue;
    try {
      records.push(JSON.parse(e.node.value));
      doneIds.add(id);
    } catch { /* ignore malformed */ }
  }

  if (total === 0) {
    return { success: true, productId, total: 0, optimized: 0, remaining: 0, advanced: false, done: true,
      score: 0, sizeSavedMB: 0, originalSizeMB: 0, optimizedSizeMB: 0, compressionRate: 0,
      message: "No photos to compress" };
  }

  const pending = images.filter(img => !doneIds.has(img.id.split("/").pop()));
  const batch = pending.slice(0, BATCH_SIZE);
  const options = batch.length > 0 ? await variantOptionsByMedia(admin, productId) : new Map();

  // Process this batch in parallel. Each result is a per-image metafield record.
  const batchResults = (await mapLimit(batch, BATCH_CONCURRENCY, async (image) => {
    try {
      const opt = await optimizeImage(image.url);

      // Re-encoding an already-tiny image can grow it — skip so we never
      // degrade the merchant's image. Mark as processed so it isn't retried.
      if (opt.optimizedSizeMB >= opt.originalSizeMB) {
        const key = `image_${image.id.split("/").pop()}`;
        return {
          key,
          record: { status: "skipped", originalSizeMB: opt.originalSizeMB, optimizedSizeMB: opt.originalSizeMB, compressionRate: 0, optimizedAt: new Date().toISOString() },
        };
      }

      // Auto alt text is a Shop+ feature; Free plans (genAlt=false) keep the
      // image's existing alt and skip AI generation.
      let altText = image.altText;
      if (genAlt && (!altText || altText.length < 10)) {
        altText = await generateAIAltText(image.url, product.title);
      }

      const position = images.findIndex(i => i.id === image.id) + 1;
      const baseName = seoBaseName(product.handle, position, options.get(image.id));
      const newId = await uploadOptimizedImage(admin, opt.optimizedBuffer, altText, baseName);
      const key = `image_${newId.split("/").pop()}`;
      return {
        key,
        replacement: { oldId: image.id, newId },
        record: {
          status: "optimized",
          originalSizeMB: opt.originalSizeMB,
          optimizedSizeMB: opt.optimizedSizeMB,
          compressionRate: opt.compressionRate,
          altText,
          optimizedAt: new Date().toISOString(),
          originalImageId: image.id,
          newImageId: newId,
        },
      };
    } catch (err) {
      const detail = err?.graphQLErrors?.[0]?.message || err?.message || "optimize failed";
      console.error(`[OPTIMIZE] ${image.id}:`, detail);
      return null; // failure — leave pending, don't write a metafield
    }
  })).filter(Boolean);

  // Record, then swap (see commitReplacements). Failures stay pending.
  const { kept: newRecords, error: commitError } = await commitReplacements(admin, productId, batchResults, mediaOrder);
  if (commitError) return { success: false, productId, error: `Could not save progress on "${product.title}": ${commitError}` };

  // Count only images that were actually re-encoded (not skipped).
  const optimizedCount = newRecords.filter(r => r.record.status === "optimized").length;
  if (shop && optimizedCount > 0) {
    try { await incrementUsage(shop, optimizedCount); }
    catch (e) { console.error("[USAGE] increment failed:", e?.message || e); }
  }

  const allRecords = [...records, ...newRecords.map(r => r.record)];
  const totals = await writeSummary(admin, productId, total, allRecords);

  const processed = Math.min(totals.processed, total);
  const remaining = total - processed;
  const advanced = newRecords.length > 0;

  return {
    success: true,
    productId,
    title: product.title,
    total,
    optimized: processed,
    remaining,
    advanced,
    done: remaining === 0,
    score: total > 0 ? Math.round((processed / total) * 100) : 0,
    sizeSavedMB: totals.totalSizeSavedMB,
    originalSizeMB: totals.totalOriginalSizeMB,
    optimizedSizeMB: totals.totalOptimizedSizeMB,
    compressionRate: totals.totalOriginalSizeMB > 0
      ? Math.round((totals.totalSizeSavedMB / totals.totalOriginalSizeMB) * 100)
      : 0,
    batchFailures: batch.length - newRecords.length,
    message: remaining === 0
      ? `Compressed "${product.title}" — ${processed}/${total} photos`
      : `Compressing "${product.title}" — ${processed}/${total} photos`,
  };
}

// Photo health audit: scores every product photo in the catalog on the things
// that make a storefront slow, inconsistent or invisible to search, and groups
// the problems into issues the merchant can fix from the audit page.
//
// Checks per photo:
//   heavy     — file over HEAVY_BYTES                       → Compress
//   alt       — missing or too-short alt text               → AI alt text
//   name      — file name doesn't describe the product      → SEO rename
//   shape     — aspect ratio differs from the product's main photo → Studio
//   lowRes    — shorter side under LOW_RES_PX (looks soft when zoomed)
//   duplicate — same size and dimensions as another photo on the product
import { fetchAllProducts, parseSummary } from "./catalog.server";

export const AUDIT_MEDIA_PER_PRODUCT = 20;
const HEAVY_BYTES = 500 * 1024;
const LOW_RES_PX = 800;
const SHAPE_TOLERANCE = 0.03; // 3% difference in width/height ratio

// How much each check weighs in a product's 0–100 score.
const WEIGHTS = { heavy: 25, alt: 25, name: 15, shape: 15, lowRes: 10, duplicate: 10 };

// Budget (Shopify caps a query at 1,000 requested points): per product ≈
// 1 + featuredMedia 3 + media(2 + 20 × (1 + image 1 + originalSource 1)) +
// summary 1 = 67, × 12 products ≈ 804.
const AUDIT_QUERY = `#graphql
  query AuditProducts($cursor: String) {
    products(first: 12, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        featuredMedia { preview { image { url } } }
        media(first: ${AUDIT_MEDIA_PER_PRODUCT}) {
          nodes {
            ... on MediaImage {
              id
              alt
              image { url width height }
              originalSource { fileSize }
            }
          }
        }
        summary: metafield(namespace: "image_optimization", key: "optimization_summary") { value }
      }
    }
  }
`;

function slug(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fileBase(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    const dot = last.lastIndexOf(".");
    return dot > 0 ? last.slice(0, dot) : last;
  } catch {
    return "";
  }
}

// Returns the list of failed checks for each photo of one product.
function checkProduct(product) {
  const images = (product.media?.nodes || []).filter((n) => n?.id && n.image?.url);
  const handle = slug(product.handle);
  const main = images[0];
  const mainRatio = main?.image.width && main?.image.height ? main.image.width / main.image.height : null;
  const seen = new Map(); // "bytes:w×h" -> first media id

  return images.map((img) => {
    const failed = [];
    const { width, height } = img.image;
    const bytes = img.originalSource?.fileSize ? Number(img.originalSource.fileSize) : 0;

    if (bytes > HEAVY_BYTES) failed.push("heavy");
    if (!img.alt || img.alt.trim().length < 10) failed.push("alt");
    if (handle && !slug(fileBase(img.image.url)).startsWith(handle)) failed.push("name");
    if (width && height) {
      if (Math.min(width, height) < LOW_RES_PX) failed.push("lowRes");
      if (mainRatio && img !== main && Math.abs(width / height - mainRatio) / mainRatio > SHAPE_TOLERANCE) {
        failed.push("shape");
      }
    }
    if (bytes && width && height) {
      const sig = `${bytes}:${width}x${height}`;
      if (seen.has(sig)) failed.push("duplicate");
      else seen.set(sig, img.id);
    }
    return { id: img.id, failed, bytes };
  });
}

function grade(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

// Audits the whole catalog. Returns
// { score, grade, products, photos, issues: { <check>: { photos, products: [...] } }, truncated }.
// Each issue lists affected products worst-first: { id, title, thumb, count }.
export async function auditCatalog(admin) {
  const { products, truncated } = await fetchAllProducts(admin, AUDIT_QUERY);
  const issues = Object.fromEntries(Object.keys(WEIGHTS).map((k) => [k, { photos: 0, products: [] }]));
  let scoreSum = 0;
  let scored = 0;
  let photos = 0;
  let totalBytes = 0;

  for (const product of products) {
    const results = checkProduct(product);
    if (results.length === 0) continue;
    photos += results.length;
    totalBytes += results.reduce((s, r) => s + r.bytes, 0);

    let penalty = 0;
    for (const check of Object.keys(WEIGHTS)) {
      const count = results.filter((r) => r.failed.includes(check)).length;
      if (count === 0) continue;
      penalty += WEIGHTS[check] * (count / results.length);
      issues[check].photos += count;
      issues[check].products.push({
        id: product.id,
        title: product.title,
        thumb: product.featuredMedia?.preview?.image?.url || null,
        count,
        compressed: Boolean(parseSummary(product)),
      });
    }
    scoreSum += 100 - penalty;
    scored += 1;
  }

  for (const issue of Object.values(issues)) issue.products.sort((a, b) => b.count - a.count);

  const score = scored > 0 ? Math.round(scoreSum / scored) : 100;
  return {
    score,
    grade: grade(score),
    products: products.length,
    photos,
    totalMB: totalBytes / (1024 * 1024),
    issues,
    truncated,
  };
}

import PageHeader from "../components/PageHeader";
import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useLoaderData, useFetcher, useRevalidator, useRouteError, redirect } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Page, Layout, Banner, Button, Badge, Checkbox, Select, RangeSlider, TextField, Thumbnail, Text, EmptyState,
} from "@shopify/polaris";
import { PaintBrushFlatIcon, ImageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getPlanStatus, overLimitMessage } from "../limits.server";
import { entitled } from "../plans.server";
import { getBgRemovalsLeft, incrementBgRemovals } from "../usage.server";
import { fetchAllProducts, imageNodes } from "../catalog.server";
import { parseStyle, previewStyled, studioBatch, bgRemovalConfigured, DEFAULT_STYLE } from "../studio.server";

// Budget (Shopify caps a query at 1,000 requested points): per product ≈
// 1 + featuredMedia 3 + media(2 + 20 × (1 + image 1)) = 46, × 20 products ≈ 920.
const STUDIO_QUERY = `#graphql
  query StudioProducts($cursor: String) {
    products(first: 20, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        featuredMedia { preview { image { url } } }
        media(first: 20) {
          nodes { ... on MediaImage { id image { url width height } } }
        }
      }
    }
  }
`;

// True when the product's photos don't all share the main photo's proportions.
function hasMixedShapes(images) {
  const ratios = images
    .filter((i) => i.image.width && i.image.height)
    .map((i) => i.image.width / i.image.height);
  return ratios.some((r) => Math.abs(r - ratios[0]) / ratios[0] > 0.03);
}

async function studioAccess(admin, shop) {
  const status = await getPlanStatus(admin, shop);
  const bgRemoval = entitled(status.plan, "bgRemoval") && bgRemovalConfigured();
  return {
    status,
    bgRemoval,
    bgLeft: bgRemoval ? await getBgRemovalsLeft(shop, status.plan) : 0,
  };
}

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const { status, bgRemoval, bgLeft } = await studioAccess(admin, session.shop);
  if (!entitled(status.plan, "studio")) throw redirect("/app/plan");

  const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } }).catch(() => null);
  const url = new URL(request.url);

  let products = [];
  let error = null;
  try {
    const result = await fetchAllProducts(admin, STUDIO_QUERY);
    products = result.products
      .map((p) => {
        const images = imageNodes(p);
        return {
          id: p.id,
          title: p.title,
          thumb: p.featuredMedia?.preview?.image?.url || images[0]?.image.url || null,
          imageCount: images.length,
          mixed: hasMixedShapes(images),
        };
      })
      .filter((p) => p.imageCount > 0);
  } catch (e) {
    console.error("[STUDIO] load failed:", e?.message || e);
    error = "Could not load your products. Refresh to try again.";
  }

  return {
    products,
    error,
    initialFilter: url.searchParams.get("filter") === "mixed" ? "mixed" : "all",
    style: parseStyle(settings?.studioStyle ?? DEFAULT_STYLE),
    autoStudio: settings?.autoStudio ?? false,
    access: {
      plan: status.plan.name,
      withinLimit: status.withinLimit,
      overLimitMessage: status.withinLimit ? null : overLimitMessage(status),
      bgRemoval,
      bgLeft,
      bgAllowance: status.plan.monthlyBgRemovals,
      autopilot: entitled(status.plan, "autoOptimize"),
    },
  };
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");
  const { status, bgRemoval, bgLeft } = await studioAccess(admin, session.shop);
  if (!entitled(status.plan, "studio")) return { success: false, error: "Photo Studio is included with Shop and above." };

  const style = parseStyle(formData.get("style"));
  if (style.removeBg && !bgRemoval) style.removeBg = false;

  if (actionType === "saveStyle") {
    const autoStudio = formData.get("autoStudio") === "true" && entitled(status.plan, "autoOptimize");
    const studioStyle = JSON.stringify(style);
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, studioStyle, autoStudio },
      update: { studioStyle, autoStudio },
    });
    return { success: true, kind: "saved", autoStudio };
  }

  if (!status.withinLimit) return { success: false, kind: actionType, error: overLimitMessage(status) };

  if (actionType === "preview") {
    // Look the photo up by product — never fetch a URL the browser sent.
    const res = await admin.graphql(
      `#graphql
        query StudioPreviewPhoto($id: ID!) {
          product(id: $id) {
            media(first: 10) { nodes { ... on MediaImage { image { url } } } }
          }
        }`,
      { variables: { id: formData.get("productId") } }
    );
    const json = await res.json();
    const imageUrl = (json.data?.product?.media?.nodes || []).find((n) => n?.image?.url)?.image.url;
    if (!imageUrl) return { success: false, kind: "preview", error: "This product has no photos to preview." };
    if (style.removeBg && bgLeft <= 0) {
      return { success: false, kind: "preview", error: "This month's background removals are used up." };
    }
    try {
      const after = await previewStyled(imageUrl, style);
      if (style.removeBg) await incrementBgRemovals(session.shop, 1);
      return { success: true, kind: "preview", before: imageUrl, after };
    } catch (e) {
      return { success: false, kind: "preview", error: "Preview failed: " + (e?.message || "unknown error") };
    }
  }

  if (actionType === "studioProduct") {
    const productId = formData.get("productId");
    try {
      return {
        kind: "studioProduct",
        ...(await studioBatch(admin, productId, style, {
          shop: session.shop,
          bgRemovalsLeft: bgLeft,
          genAlt: entitled(status.plan, "altText"),
        })),
      };
    } catch (e) {
      console.error("[STUDIO] product failed:", e?.message || e);
      return { success: false, kind: "studioProduct", productId, error: "Failed to restyle product: " + (e?.message || "unknown error") };
    }
  }

  return { success: false, error: "Invalid action" };
}

const RATIO_OPTIONS = [
  { label: "Square (1:1)", value: "1:1" },
  { label: "Portrait (4:5)", value: "4:5" },
  { label: "Portrait (3:4)", value: "3:4" },
  { label: "Keep each photo's shape", value: "keep" },
];
const BACKGROUNDS = [
  { label: "White", value: "#ffffff" },
  { label: "Soft grey", value: "#f4f4f4" },
  { label: "Warm cream", value: "#faf6ef" },
  { label: "Custom…", value: "custom" },
];

export default function Studio() {
  const { products, error: loadError, initialFilter, style: savedStyle, autoStudio: savedAuto, access } = useLoaderData();
  const runFetcher = useFetcher();
  const previewFetcher = useFetcher();
  const saveFetcher = useFetcher();
  const revalidator = useRevalidator();

  const [style, setStyle] = useState(savedStyle);
  const [customBg, setCustomBg] = useState(BACKGROUNDS.some((b) => b.value === savedStyle.background) ? "" : savedStyle.background);
  const [autoStudio, setAutoStudio] = useState(savedAuto);
  // The style last applied to products — what Autopilot uses, never an
  // unapplied edit still sitting in the controls.
  const [appliedStyle, setAppliedStyle] = useState(savedStyle);
  const [filter, setFilter] = useState(initialFilter);
  const [selected, setSelected] = useState([]);
  const [previewId, setPreviewId] = useState(null);
  const [error, setError] = useState(loadError || access.overLimitMessage);
  const [notice, setNotice] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [progress, setProgress] = useState({}); // productId -> { styled, total }
  const queueRef = useRef([]);

  const bgChoice = BACKGROUNDS.some((b) => b.value === style.background && b.value !== "custom") ? style.background : "custom";
  const update = (patch) => setStyle((s) => ({ ...s, ...patch }));
  const styleJson = JSON.stringify(style);

  const shown = useMemo(
    () => (filter === "mixed" ? products.filter((p) => p.mixed) : products),
    [products, filter]
  );
  const isBusy = activeId !== null;

  const runNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      setActiveId(null);
      revalidator.revalidate();
      return;
    }
    setActiveId(next);
    runFetcher.submit({ actionType: "studioProduct", productId: next, style: styleJson }, { method: "post" });
  }, [runFetcher, revalidator, styleJson]);

  useEffect(() => {
    if (runFetcher.state !== "idle" || !runFetcher.data || runFetcher.data.kind !== "studioProduct") return;
    const d = runFetcher.data;
    if (d.productId && d.productId !== activeId) return;
    if (d.success === false) {
      setError(d.error);
      if (d.bgLimit || !access.withinLimit) queueRef.current = [];
      runNext();
      return;
    }
    setProgress((p) => ({ ...p, [d.productId]: { styled: d.styled, total: d.total } }));
    if (d.done) {
      setNotice(d.message);
      runNext();
    } else if (!d.advanced) {
      setError(`Some photos on "${d.title}" couldn't be restyled. Try again.`);
      runNext();
    } else {
      runFetcher.submit({ actionType: "studioProduct", productId: d.productId, style: styleJson }, { method: "post" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runFetcher.state, runFetcher.data]);

  useEffect(() => {
    if (previewFetcher.state === "idle" && previewFetcher.data?.success === false) setError(previewFetcher.data.error);
  }, [previewFetcher.state, previewFetcher.data]);

  const saveStyle = useCallback((auto, saved) => {
    saveFetcher.submit({ actionType: "saveStyle", style: JSON.stringify(saved), autoStudio: String(auto) }, { method: "post" });
  }, [saveFetcher]);

  const apply = useCallback((ids) => {
    if (!ids.length || isBusy) return;
    setError(null);
    setNotice(null);
    // The applied style becomes the shop's default (and Autopilot's).
    setAppliedStyle(style);
    saveStyle(autoStudio, style);
    queueRef.current = [...ids];
    setSelected([]);
    runNext();
  }, [isBusy, saveStyle, runNext, style, autoStudio]);

  const preview = useCallback((product) => {
    if (!product) return;
    setPreviewId(product.id);
    setError(null);
    previewFetcher.submit({ actionType: "preview", productId: product.id, style: styleJson }, { method: "post" });
  }, [previewFetcher, styleJson]);

  const previewProduct = products.find((p) => p.id === previewId) || shown[0];
  const previewData = previewFetcher.data?.success ? previewFetcher.data : null;
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <PageHeader
            icon={PaintBrushFlatIcon}
            eyebrow="Photo Studio"
            title="Consistent product photos"
            subtitle="Give every photo the same shape, padding and background, centred on the product"
          />
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        )}
        {notice && (
          <Layout.Section>
            <Banner tone="success" onDismiss={() => setNotice(null)}>{notice}</Banner>
          </Layout.Section>
        )}

        <Layout.Section variant="oneThird">
          <div className="pp-side-card">
            <div className="pp-side-block">
              <span className="pp-side-title">Style</span>
              <Select label="Shape" options={RATIO_OPTIONS} value={style.ratio} onChange={(v) => update({ ratio: v })} disabled={isBusy} />
              <Select
                label="Background"
                options={BACKGROUNDS}
                value={bgChoice}
                onChange={(v) => update({ background: v === "custom" ? (customBg || "#ffffff") : v })}
                disabled={isBusy}
              />
              {bgChoice === "custom" && (
                <TextField
                  label="Custom colour"
                  value={customBg}
                  placeholder="#eef2f0"
                  autoComplete="off"
                  onChange={(v) => {
                    setCustomBg(v);
                    if (/^#[0-9a-f]{6}$/i.test(v)) update({ background: v });
                  }}
                  prefix={<span className="pp-swatch"><i style={{ background: style.background }} /></span>}
                  disabled={isBusy}
                />
              )}
              <RangeSlider
                label="Padding"
                min={0}
                max={20}
                value={style.padding}
                onChange={(v) => update({ padding: v })}
                output
                suffix={<Text as="span">{`${style.padding}%`}</Text>}
                disabled={isBusy}
              />
              <Checkbox
                label="Centre the product by trimming empty edges"
                checked={style.trim}
                onChange={(v) => update({ trim: v })}
                disabled={isBusy}
              />
              <Checkbox
                label="Remove the original background (AI)"
                checked={style.removeBg && access.bgRemoval}
                onChange={(v) => update({ removeBg: v })}
                disabled={isBusy || !access.bgRemoval}
                helpText={access.bgRemoval
                  ? `${access.bgLeft.toLocaleString()} of ${access.bgAllowance.toLocaleString()} left this month. Each photo uses one.`
                  : "Included with Brand and Catalog."}
              />
            </div>
            <div className="pp-side-block">
              <div className="pp-side-row">
                <span className="pp-side-title">New products</span>
                {!access.autopilot && <Badge tone="attention">Brand+</Badge>}
              </div>
              <Checkbox
                label="Apply this style to new products automatically"
                checked={autoStudio && access.autopilot}
                disabled={!access.autopilot || saveFetcher.state !== "idle"}
                onChange={(v) => {
                  setAutoStudio(v);
                  saveStyle(v, appliedStyle);
                }}
                helpText="Uses the style you last applied. Runs with Autopilot (turn it on from the Compress page)."
              />
            </div>
            <p className="pp-side-note">Changed your mind? Restore any product to its original photos from the Compress page.</p>
          </div>
        </Layout.Section>

        <Layout.Section>
          <div className="pp-panel">
            <div className="pp-side-row" style={{ marginBottom: 12 }}>
              <p className="pp-panel-title" style={{ margin: 0 }}>Preview</p>
              <Button
                onClick={() => preview(previewProduct)}
                loading={previewFetcher.state !== "idle"}
                disabled={!previewProduct || isBusy || !access.withinLimit}
              >
                {previewProduct ? `Preview "${previewProduct.title}"` : "Preview"}
              </Button>
            </div>
            {previewData ? (
              <div className="pp-studio-preview">
                <div className="pp-studio-frame"><img src={previewData.before} alt="Original" />Original</div>
                <div className="pp-studio-frame"><img src={previewData.after} alt="With this style" />With this style</div>
              </div>
            ) : (
              <Text as="p" tone="subdued">Pick a product below and preview its main photo with this style before applying it.</Text>
            )}
          </div>
        </Layout.Section>

        <Layout.Section>
          <div className="pp-list">
            <div className="pp-toolbar">
              <div className="pp-tabs" role="tablist" aria-label="Filter products">
                {[
                  { value: "mixed", label: "Mixed shapes", count: products.filter((p) => p.mixed).length },
                  { value: "all", label: "All", count: products.length },
                ].map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={filter === o.value}
                    className={`pp-tab${filter === o.value ? " is-active" : ""}`}
                    onClick={() => setFilter(o.value)}
                    disabled={isBusy}
                  >
                    {o.label}
                    <span className="pp-tab-count">{o.count}</span>
                  </button>
                ))}
              </div>
              <Button
                variant="primary"
                onClick={() => apply(selected.length ? selected : shown.map((p) => p.id))}
                disabled={isBusy || shown.length === 0 || !access.withinLimit}
                loading={isBusy}
              >
                {selected.length ? `Apply to ${selected.length} selected` : `Apply to all ${shown.length}`}
              </Button>
            </div>

            {shown.length === 0 ? (
              <EmptyState heading="Nothing to restyle here" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>{filter === "mixed" ? "Every product's photos already share one shape." : "No products with photos yet."}</p>
              </EmptyState>
            ) : (
              shown.map((p) => {
                const prog = progress[p.id];
                return (
                  <div key={p.id} className={`pp-row${selected.includes(p.id) ? " is-selected" : ""}${activeId === p.id ? " is-active" : ""}`}>
                    <Checkbox label={`Select ${p.title}`} labelHidden checked={selected.includes(p.id)} onChange={() => toggle(p.id)} disabled={isBusy} />
                    <Thumbnail source={p.thumb || ImageIcon} alt={p.title} size="small" />
                    <div className="pp-row-main">
                      <p className="pp-row-title">{p.title}</p>
                      <p className="pp-row-meta">
                        {`${p.imageCount} photo${p.imageCount === 1 ? "" : "s"}`}
                        {activeId === p.id && <span className="pp-live">Restyling</span>}
                      </p>
                    </div>
                    <span>{prog ? `${prog.styled}/${prog.total} restyled` : ""}</span>
                    <span />
                    <span>{p.mixed ? <Badge tone="attention">Mixed shapes</Badge> : <Badge>Consistent</Badge>}</span>
                    <div className="pp-row-action">
                      <Button size="slim" variant="tertiary" onClick={() => preview(p)} disabled={isBusy || !access.withinLimit}>Preview</Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

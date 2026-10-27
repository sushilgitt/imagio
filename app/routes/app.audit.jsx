import PageHeader from "../components/PageHeader";
import { useState, useCallback, useEffect, useRef } from "react";
import { useLoaderData, useFetcher, useNavigate, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Page, Layout, Banner, Button, Badge, Thumbnail, Text } from "@shopify/polaris";
import { HeartIcon, ImageIcon } from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server";
import { auditCatalog, AUDIT_MEDIA_PER_PRODUCT } from "../audit.server";
import { getPlanStatus } from "../limits.server";
import { entitled } from "../plans.server";
import { renameProductImages } from "../optimize.server";
import { PixelMeter } from "../components/Pixels";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const status = await getPlanStatus(admin, session.shop);
  const access = {
    plan: status.plan.name,
    withinLimit: status.withinLimit,
    suggestedPlan: status.suggestedPlan,
    altText: entitled(status.plan, "altText"),
    studio: entitled(status.plan, "studio"),
  };
  try {
    return { audit: await auditCatalog(admin), access, mediaPerProduct: AUDIT_MEDIA_PER_PRODUCT, error: null };
  } catch (error) {
    console.error("[AUDIT] failed:", error?.message || error);
    return { audit: null, access, error: "Could not audit your catalog. Refresh to try again." };
  }
}

// The only fix that runs inline here; every other fix opens its own tool.
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  if (formData.get("actionType") !== "renameProduct") return { success: false, error: "Invalid action" };
  const productId = formData.get("productId");
  try {
    return await renameProductImages(admin, productId);
  } catch (error) {
    return { success: false, productId, error: "Failed to rename photos: " + (error?.message || "unknown error") };
  }
}

// Copy + fix for each check, in the order shown.
const ISSUES = [
  {
    key: "heavy",
    title: "Heavy files",
    why: "Photos over 500 KB slow every page they appear on, especially on mobile.",
    fix: (a) => ({ label: "Compress", to: "/app/optimize?filter=needs_optimization", locked: !a.withinLimit }),
  },
  {
    key: "alt",
    title: "Missing alt text",
    why: "Screen readers and image search rely on alt text to know what a photo shows.",
    fix: (a) => a.altText
      ? { label: "Write alt text", to: "/app/alt-text", locked: !a.withinLimit }
      : { label: "Unlock with Shop", to: "/app/plan" },
  },
  {
    key: "name",
    title: "Unhelpful file names",
    why: "Names like IMG_2041.jpg tell search engines nothing. Rename them after the product.",
    fix: () => ({ label: "Rename all", inline: "rename" }),
  },
  {
    key: "shape",
    title: "Mixed shapes",
    why: "Photos with different proportions make collection grids and product galleries look uneven.",
    fix: (a) => a.studio
      ? { label: "Open Studio", to: "/app/studio?filter=mixed", locked: !a.withinLimit }
      : { label: "Unlock with Shop", to: "/app/plan" },
  },
  {
    key: "lowRes",
    title: "Low resolution",
    why: "Photos under 800 px on the short side look soft when shoppers zoom in. Replace them with larger originals.",
    fix: () => null,
  },
  {
    key: "duplicate",
    title: "Duplicate photos",
    why: "The same photo added twice to a product. Remove the extra copy from the product in Shopify admin.",
    fix: () => null,
  },
];

const SHOWN_PRODUCTS = 8;

export default function Audit() {
  const { audit, access, mediaPerProduct, error: loadError } = useLoaderData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const fetcher = useFetcher();
  const [error, setError] = useState(loadError);
  const [notice, setNotice] = useState(null);
  const [open, setOpen] = useState(null); // issue key whose product list is expanded
  const [renaming, setRenaming] = useState(null); // { done, total }
  const queueRef = useRef([]);

  const renameNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      setRenaming(null);
      setNotice("File names updated. The audit has been refreshed.");
      revalidator.revalidate();
      return;
    }
    fetcher.submit({ actionType: "renameProduct", productId: next }, { method: "post" });
  }, [fetcher, revalidator]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !renaming) return;
    if (fetcher.data.success === false) setError(fetcher.data.error);
    setRenaming((r) => (r ? { ...r, done: r.done + 1 } : r));
    renameNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const startRename = useCallback(() => {
    const ids = audit.issues.name.products.map((p) => p.id);
    if (!ids.length || renaming) return;
    setError(null);
    setNotice(null);
    queueRef.current = [...ids];
    setRenaming({ done: 0, total: ids.length });
    renameNext();
  }, [audit, renaming, renameNext]);

  if (!audit) {
    return (
      <Page>
        <Banner title="Audit unavailable" tone="critical">{error}</Banner>
      </Page>
    );
  }

  const tone = audit.score >= 75 ? "good" : audit.score >= 50 ? "warn" : "bad";
  const openIssues = ISSUES.filter((i) => audit.issues[i.key].photos > 0);

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <PageHeader
            icon={HeartIcon}
            eyebrow="Photo health"
            title="Catalog audit"
            subtitle="Every product photo checked for weight, alt text, file names, shape, resolution and duplicates"
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
        {!access.withinLimit && (
          <Layout.Section>
            <Banner tone="warning" title={`Your catalog has outgrown the ${access.plan} plan`}>
              {`The audit and SEO renaming still work. Upgrade to ${access.suggestedPlan} to compress, restyle and write alt text.`}
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <div className="pp-audit-hero">
            <div className={`pp-audit-score pp-audit-score--${tone}`}>
              <span className="pp-audit-grade">{audit.grade}</span>
              <span className="pp-audit-num">{`${audit.score}/100`}</span>
            </div>
            <div className="pp-audit-summary">
              <p className="pp-audit-title">
                {openIssues.length === 0 ? "Your product photos are in great shape" : `${openIssues.length} things to fix`}
              </p>
              <p className="pp-audit-sub">
                {`${audit.products.toLocaleString()} products · ${audit.photos.toLocaleString()} photos · ${audit.totalMB.toFixed(1)} MB`}
              </p>
              <PixelMeter pct={audit.score} label={`Photo health score ${audit.score} out of 100`} />
              <p className="pp-audit-foot">
                {`Checks the first ${mediaPerProduct} photos of each product.`}
                {audit.truncated ? " Very large catalog: only part of it was audited." : ""}
              </p>
            </div>
          </div>
        </Layout.Section>

        <Layout.Section>
          <div className="pp-issues">
            {ISSUES.map((issue) => {
              const data = audit.issues[issue.key];
              const fix = issue.fix(access);
              const clear = data.photos === 0;
              const isOpen = open === issue.key;
              return (
                <div key={issue.key} className={`pp-issue${clear ? " is-clear" : ""}`}>
                  <div className="pp-issue-head">
                    <p className="pp-issue-title">{issue.title}</p>
                    {clear
                      ? <Badge tone="success">All good</Badge>
                      : <Badge tone="attention">{`${data.photos} photo${data.photos === 1 ? "" : "s"}`}</Badge>}
                  </div>
                  <p className="pp-issue-why">{issue.why}</p>
                  {!clear && (
                    <div className="pp-issue-actions">
                      {fix?.inline === "rename" && (
                        <Button variant="primary" onClick={startRename} loading={Boolean(renaming)} disabled={Boolean(renaming)}>
                          {renaming ? `Renaming ${renaming.done}/${renaming.total}` : `${fix.label} (${data.products.length})`}
                        </Button>
                      )}
                      {fix?.to && (
                        <Button variant="primary" onClick={() => navigate(fix.to)} disabled={fix.locked}>
                          {fix.label}
                        </Button>
                      )}
                      <Button variant="tertiary" onClick={() => setOpen(isOpen ? null : issue.key)}>
                        {isOpen ? "Hide products" : `Show ${data.products.length} product${data.products.length === 1 ? "" : "s"}`}
                      </Button>
                    </div>
                  )}
                  {isOpen && (
                    <ul className="pp-issue-list">
                      {data.products.slice(0, SHOWN_PRODUCTS).map((p) => (
                        <li key={p.id}>
                          <Thumbnail source={p.thumb || ImageIcon} alt="" size="small" />
                          <a href={`shopify://admin/products/${p.id.split("/").pop()}`} target="_top">{p.title}</a>
                          <Text as="span" tone="subdued">{`${p.count} photo${p.count === 1 ? "" : "s"}`}</Text>
                        </li>
                      ))}
                      {data.products.length > SHOWN_PRODUCTS && (
                        <li className="pp-issue-more">{`and ${data.products.length - SHOWN_PRODUCTS} more`}</li>
                      )}
                    </ul>
                  )}
                </div>
              );
            })}
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

import { useNavigate, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getUsage } from "../usage.server";
import { entitled } from "../plans.server";
import { getPlanStatus } from "../limits.server";
import db from "../db.server";
import { Page, Button, Badge, Icon } from "@shopify/polaris";
import {
  HeartIcon,
  PaintBrushFlatIcon,
  ImageMagicIcon,
  MagicIcon,
  AutomationIcon,
  PlanIcon,
  ImagesIcon,
  ProductIcon,
} from "@shopify/polaris-icons";
import { BrandMark, Mosaic, PixelMeter } from "../components/Pixels";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const status = await getPlanStatus(admin, session.shop);

  let usage = { imagesUsed: 0 };
  let autoOptimize = false;
  try {
    usage = await getUsage(session.shop);
    const settings = await db.shopSettings.findUnique({ where: { shop: session.shop } });
    autoOptimize = settings?.autoOptimize ?? false;
  } catch { /* usage/settings tables not ready — defaults */ }

  return {
    plan: {
      name: status.plan.name,
      tier: status.plan.tier,
      maxProducts: status.maxProducts,
      productCount: status.productCount,
      withinLimit: status.withinLimit,
      suggestedPlan: status.suggestedPlan,
      altText: entitled(status.plan, "altText"),
      studio: entitled(status.plan, "studio"),
      autoOptimizeAllowed: entitled(status.plan, "autoOptimize"),
    },
    usage,
    autoOptimize,
  };
};

export default function Index() {
  const navigate = useNavigate();
  const { plan, usage, autoOptimize } = useLoaderData();

  const fmt = (n) => Number(n).toLocaleString();
  const pct = plan.maxProducts > 0 ? Math.min(100, Math.round((plan.productCount / plan.maxProducts) * 100)) : 100;

  const autoStatus = !plan.autoOptimizeAllowed
    ? { label: "Brand plan", tone: "attention" }
    : autoOptimize
      ? { label: "Running", tone: "success" }
      : { label: "Paused", tone: undefined };

  const tools = [
    {
      icon: HeartIcon,
      title: "Photo health",
      desc: "Score every product photo for weight, alt text, file names, shape, resolution and duplicates — then fix each issue in one click.",
      cta: "Run the check",
      onClick: () => navigate("/app/audit"),
      available: true,
    },
    {
      icon: PaintBrushFlatIcon,
      title: "Studio",
      desc: "Give every photo the same shape, padding and background, centred on the product. Preview before you apply.",
      cta: plan.studio ? "Open Studio" : "Unlock with Shop",
      onClick: () => navigate(plan.studio ? "/app/studio" : "/app/plan"),
      available: plan.studio,
      badge: plan.studio ? undefined : { label: "Shop+", tone: "attention" },
    },
    {
      icon: ImageMagicIcon,
      title: "Compress & restore",
      desc: "Lean WebP files with search-friendly names, replaced on the product. Changed your mind? Restore the originals in one click.",
      cta: "Open Compress",
      onClick: () => navigate("/app/optimize"),
      available: true,
    },
    {
      icon: MagicIcon,
      title: "Alt text",
      desc: "AI describes each product's main photo so shoppers using screen readers and image search know what it shows.",
      cta: plan.altText ? "Write alt text" : "Unlock with Shop",
      onClick: () => navigate(plan.altText ? "/app/alt-text" : "/app/plan"),
      available: plan.altText,
      badge: plan.altText ? undefined : { label: "Shop+", tone: "attention" },
    },
    {
      icon: AutomationIcon,
      title: "Autopilot",
      desc: "New products get your Studio style — or plain compression — the moment they are created.",
      cta: plan.autoOptimizeAllowed ? "Configure" : "Unlock with Brand",
      onClick: () => navigate(plan.autoOptimizeAllowed ? "/app/optimize" : "/app/plan"),
      available: plan.autoOptimizeAllowed,
      badge: autoStatus,
    },
  ];

  const steps = [
    { title: "Check your photos", desc: "Photo health scores your whole catalog and lists exactly what to fix." },
    { title: "Fix in one click", desc: "Restyle in Studio, compress, rename and caption — product by product or all at once." },
    { title: "Undo anything", desc: "Every change keeps the original in Files, and Restore puts it back exactly as it was." },
  ];

  const stats = [
    { icon: PlanIcon, label: "Plan", value: plan.name },
    { icon: ProductIcon, label: "Products covered", value: `${fmt(plan.productCount)} / ${fmt(plan.maxProducts)}` },
    { icon: ImagesIcon, label: "Photos improved this month", value: fmt(usage?.imagesUsed || 0) },
    { icon: AutomationIcon, label: "Autopilot", value: autoStatus.label },
  ];

  return (
    <Page>
      <section className="pp-hero">
        <div className="pp-hero-main">
          <p className="pp-kicker"><BrandMark />IMAGIO</p>
          <h1>
            Product photos that look like <em>one brand.</em>
          </h1>
          <p className="pp-hero-sub">
            Find what is wrong with your product photos, make them consistent in one click, and keep
            them light and search-friendly — with a one-click undo for every change.
          </p>
          <div className="pp-actions">
            <button type="button" className="pp-btn pp-btn-primary" onClick={() => navigate("/app/audit")}>
              Check photo health
            </button>
            <button type="button" className="pp-btn pp-btn-outline" onClick={() => navigate("/app/plan")}>
              View plan
            </button>
          </div>
          <Mosaic />
        </div>

        <div className="pp-usage-card">
          <Mosaic />
          <div>
            <p className="pp-usage-label">{`${plan.name} plan`}</p>
            <p className="pp-usage-big">
              {fmt(plan.productCount)}<span>{` / ${fmt(plan.maxProducts)}`}</span>
            </p>
            <p className="pp-usage-foot">products covered</p>
          </div>
          <PixelMeter pct={pct} label={`${pct}% of your plan's product limit`} />
          <p className="pp-usage-foot">
            {plan.withinLimit
              ? "Every feature on your plan is unlocked"
              : `Catalog outgrew ${plan.name} — upgrade to ${plan.suggestedPlan}`}
          </p>
        </div>
      </section>

      <div className="pp-stats">
        {stats.map((s) => (
          <div key={s.label} className="pp-stat">
            <div className="pp-stat-top">
              <span className="pp-stat-icon"><Icon source={s.icon} /></span>
              {s.label}
            </div>
            <p className="pp-stat-value">{s.value}</p>
          </div>
        ))}
      </div>

      <p className="pp-section-title">How it works</p>
      <div className="pp-steps">
        {steps.map((s, i) => (
          <div key={s.title} className="pp-step">
            <span className="pp-step-num">{i + 1}</span>
            <p className="pp-step-title">{s.title}</p>
            <p className="pp-step-desc">{s.desc}</p>
          </div>
        ))}
      </div>

      <p className="pp-section-title">Your tools</p>
      <div className="pp-tools">
        {tools.map((t) => (
          <div key={t.title} className={`pp-tool${t.available ? "" : " pp-tool-locked"}`}>
            <span className="pp-tool-icon"><Icon source={t.icon} /></span>
            <div className="pp-tool-body">
              <div className="pp-tool-head">
                <p className="pp-tool-title">{t.title}</p>
                {t.badge && <Badge tone={t.badge.tone}>{t.badge.label}</Badge>}
              </div>
              <p className="pp-tool-desc">{t.desc}</p>
              <div>
                <Button variant={t.available ? "primary" : "secondary"} onClick={t.onClick}>
                  {t.cta}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ height: 24 }} />
    </Page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

// Client-safe pricing display catalog (marketing copy + prices) for the pricing
// page and pricing wall. The source of truth for runtime gating/limits is
// plans.server.js — keep the prices/limits here in sync with that file and with
// the plans created in the Partner Dashboard.
//
// Note: because this is a Managed Pricing app, every "Choose plan" button sends
// the merchant to Shopify's hosted pricing page where they pick the real plan —
// the per-tier buttons here are purely informational about what they'll get.
export const PLAN_TIERS = [
  {
    name: "Free",
    price: 0,
    priceAnnual: 0,
    products: "25",
    tagline: "Try it on a small catalog",
    features: [
      "Up to 25 products",
      "Photo health audit",
      "WebP compression with one-click restore",
      "SEO file names",
    ],
  },
  {
    name: "Shop",
    price: 12,
    priceAnnual: 120,
    products: "250",
    tagline: "For growing shops",
    features: [
      "Up to 250 products",
      "Everything in Free",
      "AI alt text",
      "Photo studio: crop, padding, white background",
    ],
  },
  {
    name: "Brand",
    price: 29,
    priceAnnual: 290,
    products: "2,000",
    tagline: "For established brands",
    popular: true,
    features: [
      "Up to 2,000 products",
      "Everything in Shop",
      "Autopilot: new products styled automatically",
      "200 AI background removals a month",
    ],
  },
  {
    name: "Catalog",
    price: 79,
    priceAnnual: 790,
    products: "20,000",
    tagline: "For large catalogs",
    features: [
      "Up to 20,000 products",
      "Everything in Brand",
      "1,000 AI background removals a month",
    ],
  },
];

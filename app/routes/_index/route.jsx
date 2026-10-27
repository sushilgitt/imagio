import { redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // No shop-domain form: App Store apps must be installed and opened from
  // Shopify (App Store / admin), never by typing a myshopify.com URL here.
  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <p className={styles.eyebrow}>
          <span className={styles.mark} aria-hidden="true"><span>i</span></span>
          Imagio
        </p>
        <h1 className={styles.heading}>
          Product photos that look like <em>one brand.</em>
        </h1>
        <p className={styles.text}>
          Imagio checks every Shopify product photo, makes them consistent in one click and keeps them
          light and search-friendly — with a one-click undo for every change.
        </p>
        <p className={styles.note}>
          Get Imagio from the Shopify App Store, then open it from Apps in your Shopify admin.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Photo health</strong> A catalog score for weight, alt text, file names, shape, resolution and duplicates.
          </li>
          <li>
            <strong>Studio</strong> Same shape, padding and background on every photo, centred on the product.
          </li>
          <li>
            <strong>Compress &amp; restore</strong> Lean WebP files with SEO names, and the originals back in one click.
          </li>
        </ul>
      </div>
    </div>
  );
}

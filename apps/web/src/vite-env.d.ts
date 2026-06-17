/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_MAP_STYLE_URL?: string;
  /** Cloudflare Turnstile site key. When set, /register shows the captcha. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /**
   * Cloudflare Web Analytics token (public). When set, the cookieless beacon is
   * injected and a privacy note shows in the footer. Set in production only; left
   * unset in dev/UAT/e2e so they emit no analytics. See lib/cloudflare-analytics.ts.
   */
  readonly VITE_CF_WEB_ANALYTICS_TOKEN?: string;
  /**
   * When set (e2e/dev only), injects test helpers under `window.__gctp` — e.g.
   * the live MapLibre map for Playwright assertions. Unset in normal builds, so
   * the helper code tree-shakes away. See src/lib/test-helpers.ts.
   */
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

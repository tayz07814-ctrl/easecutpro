// Cloud build (Vercel + Supabase) — renderer-only Vite build. No Electron
// main/preload, no PC server: the bundle is a static SPA that talks to
// Supabase (auth/projects/settings/edge functions) and does all media work
// on-device. `npm run build:cloud` -> dist-cloud/ (what Vercel serves).
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** The index.html CSP is written for Electron/self-host (same-origin only) —
 *  it blocks fetch() to *.supabase.co ("Failed to fetch" on login) and wasm
 *  compilation (in-browser Silero VAD). Rewrite it for the cloud origin:
 *  connect to the Supabase project, allow WebAssembly, allow blob: workers. */
function cloudCsp(supabaseUrl: string | undefined): Plugin {
  let origin = ''
  try {
    origin = new URL(supabaseUrl ?? '').origin
  } catch {
    /* unset locally — fall back to any supabase project */
  }
  const https = origin || 'https://*.supabase.co'
  const wss = https.replace(/^https/, 'wss')
  // Cloud Cowork uploads/downloads media + edit JSON straight to Cloudflare R2 via
  // presigned URLs; without the R2 host in connect-src the browser blocks those
  // fetches and the app dies with "Failed to fetch" on share/open.
  const r2 = 'https://*.r2.cloudflarestorage.com'
  // Uploads now go through the write-budget Worker instead of a presigned PUT,
  // so its host has to be allowed too — a host missing from connect-src is
  // blocked by the browser BEFORE the request is sent, and XHR reports that as
  // a bare "network error" with no status, which looks nothing like a CSP
  // problem. (Downloads are still presigned GETs straight from R2, hence both.)
  const worker = 'https://*.workers.dev'
  const CSP = [
    "default-src 'self'",
    `connect-src 'self' blob: data: ${https} ${wss} ${r2} ${worker}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    // Custom fonts register as FontFaces from data:/blob: URLs (uploaded files +
    // the localStorage cache + Supabase downloads). Without this they fall back to
    // default-src 'self' and the browser blocks them ("A network error occurred"),
    // so imported fonts silently render as the fallback sans-serif.
    // fonts.gstatic.com: the landing page's webfonts (Space Grotesk / Hanken
    // Grotesk) — without it the marketing page silently renders in system fonts.
    "font-src 'self' data: blob: https://fonts.gstatic.com",
    // fonts.googleapis.com serves the landing webfonts' stylesheet.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // wasm-unsafe-eval: onnxruntime-web (Silero VAD) compiles wasm at runtime
    "script-src 'self' 'wasm-unsafe-eval'",
    // ort spawns blob: workers for its wasm proxy/threads
    "worker-src 'self' blob:"
  ].join('; ')
  return {
    name: 'cloud-csp',
    transformIndexHtml(html) {
      return html.replace(
        /(http-equiv="Content-Security-Policy"[\s\S]*?content=")[^"]*(")/,
        `$1${CSP}$2`
      )
    }
  }
}

const SITE = 'https://www.easecutpro.com'

/** SEO for the public site. The SPA shell Vercel serves on every route is an
 *  empty <div id="root"> with the title "EaseCutPro" — invisible to search
 *  engines until (if ever) they execute the JS bundle. This plugin makes the
 *  homepage crawlable without JS:
 *   - keyword-bearing <title> + meta description + canonical + Open Graph tags
 *   - JSON-LD (SoftwareApplication with pricing, FAQPage extracted from the
 *     landing markup so it can never drift out of sync with the visible FAQ)
 *   - the full landing template prerendered into #root. React's createRoot()
 *     replaces it on mount, so the app behaves exactly as before; crawlers and
 *     first paint get the real content. (On non-landing routes the static hero
 *     shows for the moment before the bundle mounts — cosmetic only.)
 *  Companion statics (robots.txt, sitemap.xml, favicon, /descript-alternative
 *  and friends) live in seo/ and are staged by prepare-cloud-assets.mjs. */
function cloudSeo(): Plugin {
  const template = readFileSync(
    resolve(__dirname, 'src/renderer/src/landing/landing.template.html'),
    'utf8'
  )

  const strip = (s: string): string =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  // Each FAQ item is a button[data-faq] (question in its first <span>) followed
  // by a [data-ans] block (answer in its <p>).
  const faq: Array<{ q: string; a: string }> = []
  const faqRe =
    /<button[^>]*data-faq[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>[\s\S]*?data-ans[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g
  for (let m = faqRe.exec(template); m; m = faqRe.exec(template)) {
    faq.push({ q: strip(m[1]), a: strip(m[2]) })
  }

  const title = 'Easecut — Transcript-Based AI Video Editor | Auto-Cut Retakes & Silence'
  const description =
    'Easecut is a transcript-based video editor with AI auto-cut. It finds retakes, filler, and long pauses in raw talking-head footage, you approve every cut, and it exports a publish-ready video in minutes.'

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'Easecut',
      alternateName: 'EaseCutPro',
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Web',
      url: `${SITE}/`,
      description,
      offers: {
        '@type': 'AggregateOffer',
        priceCurrency: 'USD',
        lowPrice: '29',
        highPrice: '79',
        offerCount: 3
      }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map(({ q, a }) => ({
        '@type': 'Question',
        name: q,
        acceptedAnswer: { '@type': 'Answer', text: a }
      }))
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Easecut',
      url: `${SITE}/`,
      logo: `${SITE}/favicon.svg`,
      email: 'support@easecutpro.com'
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Easecut',
      url: `${SITE}/`
    }
  ]

  // The font links carry LandingScreen's ensureFonts() id, so it detects them
  // and skips re-adding the stylesheet at runtime.
  const head = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${SITE}/" />`,
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Easecut" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${SITE}/" />`,
    `<meta property="og:image" content="${SITE}/og.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${SITE}/og.png" />`,
    `<link rel="preconnect" href="https://fonts.googleapis.com" />`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />`,
    `<link id="ec-landing-fonts" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&amp;family=Hanken+Grotesk:wght@400;500;600;700&amp;display=swap" />`,
    `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`
  ].join('\n    ')

  return {
    name: 'cloud-seo',
    transformIndexHtml(html) {
      // Replacer callbacks so "$" sequences in the markup are never treated as
      // replacement patterns.
      return html
        .replace('<title>EaseCutPro</title>', () => head)
        .replace(
          '<div id="root"></div>',
          () => `<div id="root"><div class="ec-landing">${template}</div></div>`
        )
    }
  }
}

export default defineConfig(({ mode }) => {
  // '' prefix = also surface non-VITE process.env (Vercel sets real env vars).
  const env = loadEnv(mode, __dirname, '')
  return {
    root: resolve(__dirname, 'src/renderer'),
    // VITE_SUPABASE_* come from .env files here (or real env vars on Vercel).
    envDir: __dirname,
    // Dev parity for the production /edge rewrite (vercel.json): the app calls
    // edge functions same-origin (ad-blocker-proof); proxy them to the Supabase
    // functions host in `dev:cloud` too. Without the env var the app's built-in
    // fallback (direct supabase-js call) still keeps everything working.
    server: env.VITE_SUPABASE_URL
      ? {
          proxy: {
            '/edge': {
              target: `${env.VITE_SUPABASE_URL.replace(/\/$/, '')}/functions/v1`,
              changeOrigin: true,
              rewrite: (p: string) => p.replace(/^\/edge/, '')
            }
          }
        }
      : undefined,
    // Generated by scripts/prepare-cloud-assets.mjs: /vad/ (Silero ONNX + ORT wasm).
    publicDir: resolve(__dirname, '.cloud-public'),
    define: {
      // Hard-bake the cloud flag — IS_CLOUD gates compile away in other builds.
      'import.meta.env.VITE_CLOUD': JSON.stringify('1')
    },
    build: {
      outDir: resolve(__dirname, 'dist-cloud'),
      emptyOutDir: true,
      // Source maps are published alongside the bundle, so shipping them hands
      // every visitor the full readable client source — including the shape of
      // the edge-function calls and which checks run where. Set
      // EC_SOURCEMAPS=1 for a debugging build when an on-device stack (mobile
      // Safari) needs decoding; production ships without them.
      sourcemap: process.env.EC_SOURCEMAPS === '1',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react(), cloudCsp(env.VITE_SUPABASE_URL), cloudSeo()]
  }
})

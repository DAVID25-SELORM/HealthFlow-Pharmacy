import { Helmet } from 'react-helmet-async'

// Canonical public origin used for absolute URLs in tags/sitemap.
// Override at build time with VITE_PUBLIC_SITE_URL when a custom domain is ready.
const SITE_URL = (import.meta.env?.VITE_PUBLIC_SITE_URL || 'https://healthflowcloud.com').replace(/\/+$/, '')
const DEFAULT_OG_IMAGE = '/app-logo.png'
const SITE_NAME = 'HealthFlow'

const toAbsoluteUrl = (value) => {
  if (!value) return SITE_URL
  if (/^https?:\/\//i.test(value)) return value
  return `${SITE_URL}/${String(value).replace(/^\/+/, '')}`
}

/**
 * Per-page SEO tags. Public pages pass a path + description; authenticated
 * pages pass noindex to keep private screens out of search engines.
 */
const Seo = ({
  title,
  description = '',
  path = '',
  image = DEFAULT_OG_IMAGE,
  noindex = false,
  type = 'website',
  jsonLd = null,
}) => {
  const fullTitle = title ? `${title} | ${SITE_NAME}` : `${SITE_NAME} - Pharmacy, Claims & Facility Operations`
  const canonical = toAbsoluteUrl(path)
  const ogImage = toAbsoluteUrl(image)

  return (
    <Helmet prioritizeSeoTags>
      <title>{fullTitle}</title>
      {description && <meta name="description" content={description} />}
      <link rel="canonical" href={canonical} />
      {noindex
        ? <meta name="robots" content="noindex, nofollow" />
        : <meta name="robots" content="index, follow" />}

      {/* Open Graph (Facebook, WhatsApp, LinkedIn link previews) */}
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:type" content={type} />
      <meta property="og:title" content={fullTitle} />
      {description && <meta property="og:description" content={description} />}
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={ogImage} />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      {description && <meta name="twitter:description" content={description} />}
      <meta name="twitter:image" content={ogImage} />

      {jsonLd && (
        <script type="application/ld+json">{JSON.stringify(jsonLd)}</script>
      )}
    </Helmet>
  )
}

export default Seo

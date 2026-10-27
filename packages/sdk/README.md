# @metricpanel/sdk

Official TypeScript/JavaScript SDK for MetricPanel Analytics.

## Features

- TypeScript support
- Lightweight browser bundle
- Privacy controls for Do Not Track, cookieless mode, and consent gating
- Browser support for React, Vue, Svelte, vanilla JS, and modern bundlers
- React Native/native JavaScript entrypoint without DOM globals
- Pageviews, screen views, events, revenue, and goals
- Session-scoped last-touch campaign attribution across internal navigation
- Hostname and query capture plus first-external-referrer persistence for acquisition reports
- Stripe metadata helpers for revenue attribution

## Installation

```bash
npm add @metricpanel/sdk
```

Other supported package managers:

```bash
bun add @metricpanel/sdk
npm install @metricpanel/sdk
pnpm add @metricpanel/sdk
yarn add @metricpanel/sdk
```

## Quick Start

```typescript
import { createMetricPanel } from '@metricpanel/sdk'

const metricpanel = createMetricPanel({
  websiteId: 'your-website-id',
  apiUrl: 'https://api.metricpanel.io/api',
})

// Track pageview
await metricpanel.pageview()

// Track custom event
await metricpanel.event('button_click', { button: 'cta' })

// Track revenue
await metricpanel.revenue({ amount: 2999 })

// Track goal
await metricpanel.goal({ name: 'signup', value: 2500, properties: { plan: 'pro' } })
```

The browser SDK defaults to `https://api.metricpanel.io/api` and sends events to
`https://api.metricpanel.io/api/events`. The explicit value above makes the hosted destination
obvious in copied configuration. To use a first-party proxy, override `apiUrl` with the base path
that forwards the `/events` route to MetricPanel:

```typescript
const metricpanel = createMetricPanel({
  websiteId: 'your-website-id',
  apiUrl: '/analytics/api',
})
```

Trailing slashes are normalized. An empty `apiUrl` is rejected instead of falling back silently.
Revenue amounts must be positive integers in the smallest currency unit, and currency values use
three-letter ISO codes. For USD, `2999` means `$29.99`. Goal values must be non-negative integers
in the smallest currency unit. Custom event and goal properties are limited to 10 fields; keep them
flat and do not send email addresses, names, credentials, or other sensitive personal data.

## User identification

After signup or login, await `identify()` before sending account activity:

```typescript
await metricpanel.identify('user_123', {
  name: 'Jane Smith',
  email: 'jane@example.com',
})
await metricpanel.event('subscription_started', { plan: 'scale' })

// On logout, before tracking any anonymous activity:
metricpanel.reset()
```

Available in SDK 1.4.0 once published, with the corresponding identity-enabled API deployment.
Use your stable application user ID. Name and email are optional; omitted fields retain their
previous values and `null` clears a field. Only these two profile traits are supported.
A visitor cannot be reassigned to a different user: the SDK rotates visitor and session IDs
when switching accounts or when the API reports an existing conflicting binding.

Identification links the current visitor's earlier and subsequent activity to the profile.
Multiple devices with the same user ID share the profile; visitor/session counts and journey
rows remain per visitor. This does not create an event, goal, purchase or revenue entry.
Names appear in Users and user IDs/emails in visitor details. The authenticated visitors API
also returns an optional `identity` object. Profiles are scoped to each website.

Identification is disabled in cookieless mode, when Do Not Track disables browser tracking,
or until tracking consent is granted. Website cookieless and GDPR modes must also be disabled.
No profile traits are saved in browser storage or copied into ordinary event properties.
Visitor deletion removes its identity link and deletes the profile when its last link is removed.
Identification is analytics metadata, never authentication or authorization evidence.

React Native supports the same `identify()` method with persistent storage configured.
Use `await metricpanel.reset()` on native logout; `resetSession()` alone keeps the same visitor.
Server-side PHP and Laravel identification uses the browser visitor/session IDs as context.

## React Native

Use the separate native entrypoint so React Native apps do not load browser-only code:

```typescript
import { createMetricPanelNative } from '@metricpanel/sdk/react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

const metricpanel = createMetricPanelNative({
  websiteId: 'your-website-id',
  apiUrl: 'https://api.metricpanel.io/api',
  storage: AsyncStorage,
  platform: 'ios',
  os: 'iOS',
})

await metricpanel.screen('Home')
await metricpanel.event('signup_tapped', { placement: 'hero' })
await metricpanel.revenue({ amount: 2999, currency: 'usd' })
```

The native entrypoint sends events to `POST /api/events` with the same website ID,
visitor ID, session ID, event, goal, and revenue fields used by the browser SDK.
It does not include automatic navigation instrumentation, native device plugins, push
campaign attribution, or an iOS/Android platform package.

## Pageview strategy

Choose one pageview strategy per page:

- Use the hosted tracking script if you want automatic initial-load and SPA navigation pageviews.
- Use the SDK if you want to trigger pageviews manually with `metricpanel.pageview()`.

Do not load the hosted script and also call SDK pageviews for the same page lifecycle unless you intentionally want both events.

For a client-side router, keep one SDK instance and call `pageview()` after each completed route
change. Set `trackHashRoutes: true` only for routers whose route state lives in the URL hash.

## Browser and Next.js lifecycle

Importing the package is safe in Node and during Next.js server rendering, but browser tracking must
be initialized in client-side code because it reads `window`, `document`, cookies, and browser
storage.

```tsx
'use client'

import { useEffect } from 'react'
import { createMetricPanel } from '@metricpanel/sdk'

export function Analytics() {
  useEffect(() => {
    const metricpanel = createMetricPanel({
      websiteId: 'your-website-id',
      apiUrl: 'https://api.metricpanel.io/api',
    })

    void metricpanel.pageview()
    return () => metricpanel.destroy()
  }, [])

  return null
}
```

Localhost and loopback traffic is ignored by default. Set `allowLocalhost: true` while deliberately
testing a local application. `destroy()` releases an instance without removing persisted identity;
`revokeConsent()` stops tracking and removes the website-scoped consent, attribution, and cookie
identity state.

Browser persistence uses MetricPanel-owned names: `metricpanel_visitor` and
`metricpanel_session` for cookies, `metricpanel_attribution:<websiteId>` and
`metricpanel_referrer:<websiteId>` for session storage, and
`metricpanel_consent:<websiteId>` for consent storage. Version 1.1.2 automatically migrates the
legacy `mtrk_*` browser keys on first initialization, preserving existing visitor and session IDs,
campaign attribution, referrer, and granted consent while removing the legacy entries.

Network failures never break the host application. Provide `onError` if the application needs
diagnostic visibility:

```typescript
const metricpanel = createMetricPanel({
  websiteId: 'your-website-id',
  onError: (error) => reportAnalyticsDiagnostic(error),
})
```

## Documentation

See the [MetricPanel SDK guide](https://metricpanel.io/docs/sdk) for complete documentation
including:

- Installation methods
- API reference
- Framework examples (React, Vue, Svelte, Next.js)
- Stripe integration
- Best practices
- Troubleshooting

## Building

```bash
bun install
bun run build
```

Output:

- `dist/index.cjs` / `dist/index.mjs` - Browser SDK
- `dist/react-native.cjs` / `dist/react-native.mjs` - React Native/native SDK entrypoint
- `dist/*.d.ts` - TypeScript definitions and declaration maps
- `dist/*.map` - JavaScript source maps

## License

MIT

## Dashboard-managed event rules (browser SDK 1.2+)

Opt in once with `eventRules: true` on your existing SDK configuration. Manage click,
form-submit and page-visit rules in the website's Tracking settings. Rules default off
in the SDK and respect consent, Do Not Track and localhost settings. React Native does
not run browser rules.

```ts
const tracker = createMetricPanel({ websiteId: 'YOUR_PUBLIC_WEBSITE_ID', eventRules: true })
await tracker.pageview()
console.table(await tracker.previewEventRules()) // Current enabled matches; sends no events.
```

Enabled definitions refresh each minute on visible pages and on returning to the tab.
Failed refreshes clear rules; definitions expire after two minutes. Revoking consent or
calling `destroy()` removes listeners and aborts configuration loading. Rules are never
fetched before consent. Proxy users must forward `/event-rules?websiteId=...` GETs with
Origin/Referer headers as well as event POSTs.

Click rules match nested contents; submit rules match the form and measure attempts,
not successful submissions. Page rules follow explicit `pageview()` calls, including
SPA navigation tracked by your integration. Literal path patterns support `*` and ignore
queries/fragments. No form values, element text, dynamic attributes or custom scripts
are read. Events add the static name and `metricpanel_rule_id` property to normal SDK
context. Overlapping rules deduplicate event names per interaction; manual tracking is
independent, so avoid giving a rule the same event as a manual call. Preview is limited
to enabled rules on the current page and reports invalid CSS selectors.

## Web Vitals

With SDK 1.3.0+, opt in to document-level real-user performance:

```ts
const analytics = createMetricPanel({ websiteId: 'YOUR_WEBSITE_ID', webVitals: true })
```

This uses the bundled Google `web-vitals` library for LCP, INP, CLS, FCP and TTFB. Collection
starts after consent and honors Do Not Track and localhost settings. No DOM entries, text,
selectors or resource attribution are sent. The page path excludes query strings and hashes.
Measurements do not create pageviews, custom events, goal completions or live activity.

Measurements describe full document navigations and back/forward-cache restores. SPA route
changes do not start new measurements; delayed callbacks remain attributed to the document
path. Some values arrive only when a page is hidden. INP requires an interaction, and browser
support differs. Missing measurements are not zero scores.

The library registers observers once per document. `destroy()` and `revokeConsent()` detach
this instance and stop all uploads. After revocation, Web Vitals stays stopped for that SDK
instance even if consent is granted again; reload the page to begin a fresh measurement period.
This avoids replaying measurements spanning a revoked-consent period. Other SDK tracking
resumes normally. Buffered browser measurements may describe page loading before consent,
but they are read and transmitted only after consent is granted.

Open **Web Vitals** in MetricPanel for p75 values, daily trends, page breakdowns, and sample
counts. Reports keep the latest value for each metric ID, so repeated hidden/visible updates
are not counted as extra samples. Collection is best-effort and is not a Lighthouse lab test
or a replacement for Chrome UX Report field data.

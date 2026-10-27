import { BrowserEventRules } from './event-rules'
import { BrowserWebVitals } from './web-vitals'
import { normalizeIdentity, type IdentityTraits } from './identity'
export type { IdentityTraits } from './identity'
/**
 * MetricPanel Analytics SDK
 * A TypeScript SDK for tracking events, goals, and revenue
 */

export interface MetricPanelConfig {
  websiteId: string
  apiUrl?: string
  debug?: boolean
  cookieless?: boolean
  allowLocalhost?: boolean
  respectDoNotTrack?: boolean
  anonymizeIP?: boolean
  waitForConsent?: boolean
  /** Enable dashboard-managed browser event rules after consent. */
  eventRules?: boolean
  /** Collect document Web Vitals after consent. Disabled by default. */
  webVitals?: boolean
  trackHashRoutes?: boolean
  onError?: (error: Error) => void
}

export interface EventProperties {
  [key: string]: string | number | boolean | null
}

export interface RevenueData {
  amount: number // in cents
  currency?: string
  productId?: string
  productName?: string
  metadata?: Record<string, unknown>
}

export interface GoalData {
  name: string
  value?: number
  properties?: EventProperties
}

export interface PageviewData {
  path?: string
  title?: string
  referrer?: string | null
}

export type MetricPanelEventType = 'pageview' | 'event' | 'revenue' | 'goal' | 'web_vital'

export interface PrivacyMode {
  cookieless?: boolean
  disableGeo?: boolean
  anonymizeIP?: boolean
}

const VISITOR_COOKIE = 'metricpanel_visitor'
const SESSION_COOKIE = 'metricpanel_session'
const ATTRIBUTION_STORAGE_PREFIX = 'metricpanel_attribution:'
const REFERRER_STORAGE_PREFIX = 'metricpanel_referrer:'
const CONSENT_STORAGE_PREFIX = 'metricpanel_consent:'
const LEGACY_VISITOR_COOKIE = 'mtrk_vid'
const LEGACY_SESSION_COOKIE = 'mtrk_sid'
const LEGACY_ATTRIBUTION_STORAGE_PREFIX = 'mtrk_attr:'
const LEGACY_REFERRER_STORAGE_PREFIX = 'mtrk_ref:'
const LEGACY_CONSENT_STORAGE_PREFIX = 'mtrk_consent:'
const MAX_CUSTOM_PROPERTIES = 10
export const METRICPANEL_API_URL = 'https://api.metricpanel.io/api'
const ATTRIBUTION_KEYS = [
  'source',
  'medium',
  'campaign',
  'term',
  'content',
  'gclid',
  'fbclid',
  'msclkid',
] as const

type CampaignAttribution = Partial<Record<(typeof ATTRIBUTION_KEYS)[number], string>>

export class MetricPanelSDK {
  private readonly config: Required<Omit<MetricPanelConfig, 'onError'>> &
    Pick<MetricPanelConfig, 'onError'>
  private visitorId: string | null = null
  private sessionId: string | null = null
  private queue: Array<() => Promise<void>> = []
  private initialized = false
  private consentGranted = false
  private consentMode = false
  private disabled = false
  private destroyed = false
  private rules: BrowserEventRules | null = null
  private vitals: BrowserWebVitals | null = null
  private identifiedUserId: string | null = null

  constructor(config: MetricPanelConfig) {
    if (!config?.websiteId || typeof config.websiteId !== 'string') {
      throw new Error('websiteId is required')
    }

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error(
        'MetricPanel browser tracking requires window and document. Initialize it in client-side code.'
      )
    }

    if (config.apiUrl !== undefined && !config.apiUrl.trim()) {
      throw new Error('apiUrl must be a non-empty URL or path')
    }

    this.config = {
      websiteId: config.websiteId,
      apiUrl: trimTrailingSlash(config.apiUrl ?? METRICPANEL_API_URL),
      debug: config.debug ?? false,
      cookieless: config.cookieless ?? false,
      allowLocalhost: config.allowLocalhost ?? false,
      respectDoNotTrack: config.respectDoNotTrack ?? true,
      anonymizeIP: config.anonymizeIP ?? false,
      waitForConsent: config.waitForConsent ?? false,
      trackHashRoutes: config.trackHashRoutes ?? false,
      eventRules: config.eventRules ?? false,
      webVitals: config.webVitals ?? false,
      onError: config.onError,
    }

    // Set consent mode
    this.consentMode = this.config.waitForConsent || false
    this.consentGranted = !this.consentMode // If not in consent mode, assume consent

    this.migrateStorageKey(
      localStorage,
      this.getConsentStorageKey(),
      this.getLegacyConsentStorageKey()
    )
    this.migrateStorageKey(
      sessionStorage,
      this.getAttributionStorageKey(),
      this.getLegacyAttributionStorageKey()
    )
    this.migrateStorageKey(
      sessionStorage,
      this.getReferrerStorageKey(),
      this.getLegacyReferrerStorageKey()
    )

    // Check for stored consent if in consent mode
    if (this.consentMode) {
      try {
        const storedConsent = localStorage.getItem(this.getConsentStorageKey())
        if (storedConsent === 'granted') {
          this.consentGranted = true
          this.log('Restored consent from localStorage')
        }
      } catch (error) {
        this.log('Unable to check stored consent', error)
      }
    }

    // Initialize on construction (if consent granted or not in consent mode)
    if (this.consentGranted) {
      this.init()
    } else {
      this.log('Waiting for consent before initialization')
    }
  }

  /**
   * Initialize the SDK
   */
  private async init(): Promise<void> {
    if (this.destroyed) return

    if (!this.config.allowLocalhost && isLocalHostname(window.location.hostname)) {
      this.disabled = true
      this.log('Localhost tracking is disabled. Set allowLocalhost to true to enable it.')
      return
    }

    // Check Do Not Track
    if (this.config.respectDoNotTrack && this.isDoNotTrack()) {
      this.disabled = true
      this.log('Do Not Track is enabled, analytics disabled')
      return
    }

    // Generate or retrieve visitor/session IDs
    if (!this.config.cookieless) {
      this.visitorId = this.getOrCreateId(
        VISITOR_COOKIE,
        LEGACY_VISITOR_COOKIE,
        365 * 24 * 60 * 60 * 1000
      ) // 365 days
      this.sessionId = this.getOrCreateId(SESSION_COOKIE, LEGACY_SESSION_COOKIE, 30 * 60 * 1000) // 30 minutes
    } else {
      // Generate ephemeral IDs for cookieless mode
      this.visitorId = this.generateId()
      this.sessionId = this.generateId()
    }

    this.initialized = true
    if (this.config.eventRules && !this.rules) {
      this.rules = new BrowserEventRules(
        `${this.config.apiUrl}/event-rules?websiteId=${encodeURIComponent(this.config.websiteId)}`,
        (rule, path) =>
          this.track('event', {
            name: rule.eventName,
            path,
            properties: { metricpanel_rule_id: rule.id },
          })
      )
    }
    if (this.config.webVitals && !this.vitals) {
      this.vitals = new BrowserWebVitals((webVital, path, timestamp) =>
        this.track('web_vital', { webVital, path, timestamp, query: null, title: null })
      )
    }
    this.log('Initialized', { visitorId: this.visitorId, sessionId: this.sessionId })

    // Process queued events
    await this.processQueue()
  }

  /**
   * Track a pageview
   */
  async pageview(data?: PageviewData): Promise<void> {
    return this.track('pageview', {
      path: data?.path ?? this.getCurrentPath(),
      title: data?.title ?? document.title,
      ...(data?.referrer !== undefined ? { referrer: data.referrer } : {}),
    })
  }

  /** Link this visitor's activity to your user. Await after login, before tracking account activity. */
  async identify(userId: string, traits: IdentityTraits = {}): Promise<void> {
    const identity = normalizeIdentity(userId, traits)
    if (this.destroyed || this.disabled || this.config.cookieless) return
    if (!this.initialized || (this.consentMode && !this.consentGranted)) {
      const { userId: pendingUserId, ...pendingTraits } = identity
      this.queue.push(async () => {
        try {
          await this.identify(pendingUserId, pendingTraits)
        } catch (error) {
          this.config.onError?.(error instanceof Error ? error : new Error('Identification failed'))
        }
      })
      return
    }
    if (this.identifiedUserId && this.identifiedUserId !== identity.userId) this.rotateIdentity()
    for (let attempt = 0; attempt < 2; attempt++) {
      const visitorId = this.visitorId
      const response = await fetch(`${this.config.apiUrl}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          eventId: this.generateId(),
          websiteId: this.config.websiteId,
          visitorId,
          sessionId: this.sessionId,
          type: 'identify',
          path: '/',
          identity,
          timestamp: new Date().toISOString(),
        }),
      })
      // Never undo a logout/reset that happened while this request was in flight.
      if (visitorId !== this.visitorId || this.destroyed || !this.initialized) return
      if (response.status === 409 && attempt === 0) {
        this.rotateIdentity()
        continue
      }
      if (!response.ok) throw new Error(`MetricPanel identification failed with ${response.status}`)
      const result = (await response.json()) as { identified?: boolean }
      if (visitorId !== this.visitorId || this.destroyed || !this.initialized) return
      if (result.identified !== true) throw new Error('MetricPanel identification was not accepted')
      this.identifiedUserId = identity.userId
      return
    }
  }

  /** Call on logout. Rotate both IDs so later activity cannot inherit the previous account. */
  reset(): void {
    this.queue = []
    this.rotateIdentity()
  }

  private rotateIdentity(): void {
    this.identifiedUserId = null
    if (this.destroyed) return
    if (!this.config.cookieless) {
      this.deleteCookie(VISITOR_COOKIE)
      this.deleteCookie(SESSION_COOKIE)
      this.deleteCookie(LEGACY_VISITOR_COOKIE)
      this.deleteCookie(LEGACY_SESSION_COOKIE)
    }
    // Logout before consent must forget an earlier account without creating new identifiers.
    this.visitorId = null
    this.sessionId = null
    if (this.initialized && !this.disabled) {
      this.visitorId = this.generateId()
      this.sessionId = this.generateId()
      if (!this.config.cookieless) {
        this.setCookie(VISITOR_COOKIE, this.visitorId, 365 * 24 * 60 * 60 * 1000)
        this.setCookie(SESSION_COOKIE, this.sessionId, 30 * 60 * 1000)
      }
    }
    try {
      sessionStorage.removeItem(this.getAttributionStorageKey())
      sessionStorage.removeItem(this.getReferrerStorageKey())
    } catch {
      /* Tracking still works when browser storage is unavailable. */
    }
  }

  /**
   * Track a custom event
   */
  async event(name: string, properties?: EventProperties): Promise<void> {
    if (!name || typeof name !== 'string') {
      throw new Error('Event name must be a string')
    }

    if (properties && Object.keys(properties).length > MAX_CUSTOM_PROPERTIES) {
      this.log('Warning: Properties limited to 10 fields')
    }

    return this.track('event', {
      name,
      properties: normalizeProperties(properties),
    })
  }

  /**
   * Track revenue
   */
  async revenue(data: RevenueData): Promise<void> {
    if (!data || !Number.isSafeInteger(data.amount) || data.amount <= 0) {
      throw new Error('Revenue amount must be a positive integer in the smallest currency unit')
    }

    const currency = normalizeCurrency(data.currency)

    return this.track('revenue', {
      amount: data.amount,
      currency,
      productId: data.productId,
      productName: data.productName,
      metadata: data.metadata,
    })
  }

  /**
   * Track a goal conversion
   */
  async goal(data: GoalData): Promise<void> {
    if (!data || typeof data.name !== 'string' || !data.name.trim()) {
      throw new Error('Goal name is required')
    }
    if (data.value !== undefined && (!Number.isSafeInteger(data.value) || data.value < 0)) {
      throw new Error('Goal value must be a non-negative integer in the smallest currency unit')
    }
    const { value: propertyValue, ...customProperties } = data.properties ?? {}
    const goalValue = data.value !== undefined ? data.value : propertyValue
    if (Object.keys(customProperties).length > MAX_CUSTOM_PROPERTIES) {
      this.log('Warning: Properties limited to 10 fields')
    }

    return this.track('goal', {
      name: data.name.trim(),
      properties: normalizeProperties(
        customProperties,
        goalValue !== undefined ? { value: goalValue } : undefined
      ),
    })
  }

  /**
   * Get Stripe metadata for revenue attribution
   */
  getStripeMetadata(): Record<string, string> {
    const utm = this.getUtmParams()
    const metadata: Record<string, string> = {
      metricpanel_website_id: this.config.websiteId,
    }

    if (this.visitorId) metadata.metricpanel_visitor_id = this.visitorId
    if (this.sessionId) metadata.metricpanel_session_id = this.sessionId

    // Add UTM parameters
    if (utm) {
      if (utm.source) metadata.utm_source = utm.source
      if (utm.medium) metadata.utm_medium = utm.medium
      if (utm.campaign) metadata.utm_campaign = utm.campaign
      if (utm.term) metadata.utm_term = utm.term
      if (utm.content) metadata.utm_content = utm.content
      if (utm.gclid) metadata.gclid = utm.gclid
      if (utm.fbclid) metadata.fbclid = utm.fbclid
      if (utm.msclkid) metadata.msclkid = utm.msclkid
    }

    return metadata
  }

  /**
   * Get current visitor ID
   */
  getVisitorId(): string | null {
    return this.visitorId
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.sessionId
  }

  /**
   * Grant consent for tracking
   * Initializes SDK and processes queued events
   */
  async grantConsent(): Promise<void> {
    if (!this.consentMode) {
      this.log('Not in consent mode, consent already granted')
      return
    }

    if (this.consentGranted) {
      this.log('Consent already granted')
      return
    }

    this.log('Consent granted')
    this.consentGranted = true
    this.disabled = false

    // Store consent in localStorage for persistence
    try {
      localStorage.setItem(this.getConsentStorageKey(), 'granted')
    } catch (error) {
      this.log('Unable to store consent in localStorage', error)
    }

    // Initialize SDK and process queue
    await this.init()
  }

  /**
   * Revoke consent for tracking
   * Stops tracking and clears stored data
   */
  revokeConsent(): void {
    this.identifiedUserId = null
    this.vitals?.stop()
    this.rules?.stop()
    this.rules = null
    this.log('Consent revoked')
    this.consentMode = true
    this.consentGranted = false
    this.initialized = false
    this.disabled = true

    // Clear stored consent
    try {
      localStorage.removeItem(this.getConsentStorageKey())
      localStorage.removeItem(this.getLegacyConsentStorageKey())
      sessionStorage.removeItem(this.getAttributionStorageKey())
      sessionStorage.removeItem(this.getLegacyAttributionStorageKey())
      sessionStorage.removeItem(this.getReferrerStorageKey())
      sessionStorage.removeItem(this.getLegacyReferrerStorageKey())
    } catch (error) {
      this.log('Unable to clear consent from localStorage', error)
    }

    // Clear cookies if not in cookieless mode
    if (!this.config.cookieless) {
      this.deleteCookie(VISITOR_COOKIE)
      this.deleteCookie(SESSION_COOKIE)
      this.deleteCookie(LEGACY_VISITOR_COOKIE)
      this.deleteCookie(LEGACY_SESSION_COOKIE)
    }

    // Clear IDs
    this.visitorId = null
    this.sessionId = null

    // Clear queue
    this.queue = []
  }

  /**
   * Release this instance and ignore future tracking calls.
   * Stored identifiers remain available to a later instance unless consent is revoked.
   */
  destroy(): void {
    this.identifiedUserId = null
    this.vitals?.stop()
    this.rules?.stop()
    this.rules = null
    this.destroyed = true
    this.initialized = false
    this.queue = []
    this.visitorId = null
    this.sessionId = null
  }

  /** Refresh enabled rules and inspect matches on this page without sending analytics. */
  async previewEventRules() {
    await this.rules?.refresh()
    await this.rules?.ready
    return this.rules?.preview() ?? []
  }

  /** Check if consent has been granted. */
  hasConsent(): boolean {
    if (!this.consentMode) {
      return true // Not in consent mode means implicit consent
    }
    return this.consentGranted
  }

  /**
   * Core tracking method
   */
  private async track(type: MetricPanelEventType, data: Record<string, unknown>): Promise<void> {
    if (this.destroyed || this.disabled) return

    // Check consent first
    if (this.consentMode && !this.consentGranted) {
      // Queue event until consent is granted
      this.queue.push(() => this.track(type, data))
      this.log('Event queued, waiting for consent')
      return
    }

    if (!this.initialized) {
      // Queue event until initialized
      this.queue.push(() => this.track(type, data))
      return
    }

    if (!this.visitorId || !this.sessionId) {
      this.log('Error: Missing visitor or session ID')
      return
    }

    const deviceInfo = this.getDeviceInfo()
    const browserInfo = this.getBrowserInfo()
    const utm = this.getUtmParams()

    const payload = {
      eventId: this.generateId(),
      websiteId: this.config.websiteId,
      visitorId: this.visitorId,
      sessionId: this.sessionId,
      type,
      path: this.getCurrentPath(),
      hostname: window.location.hostname,
      referrer: this.getSessionReferrer(),
      title: document.title || null,
      query: this.getQueryParams(),
      ...deviceInfo,
      ...browserInfo,
      utm: utm || undefined,
      timestamp: new Date().toISOString(),
      // Include privacy mode flags
      _privacyMode: {
        cookieless: this.config.cookieless,
        disableGeo: this.config.anonymizeIP,
        anonymizeIP: this.config.anonymizeIP,
      },
      ...data,
    }

    this.log('Tracking event', payload)

    const activeRules = this.rules
    try {
      await this.send(payload)
      if (type === 'pageview' && typeof data.path === 'string')
        await activeRules?.pageview(data.path)
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error('MetricPanel event ingestion failed')
      this.log('Error sending event', normalizedError)
      this.config.onError?.(normalizedError)
    }
  }

  /**
   * Send event to API
   */
  private async send(payload: Record<string, unknown>): Promise<void> {
    const url = `${this.config.apiUrl}/events`
    const data = JSON.stringify(payload)

    // Try sendBeacon first (non-blocking)
    if (navigator.sendBeacon) {
      const blob = new Blob([data], { type: 'application/json' })
      const sent = navigator.sendBeacon(url, blob)

      if (sent) {
        this.log('Event sent via sendBeacon')
        return
      }
    }

    // Fallback to fetch
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: data,
      keepalive: true,
    })

    if (!response.ok) {
      throw new Error(`MetricPanel event ingestion failed with ${response.status}`)
    }

    this.log('Event sent via fetch')
  }

  /**
   * Process queued events
   */
  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (task) await task()
    }
  }

  /**
   * Get or create ID with cookie storage
   */
  private getOrCreateId(name: string, legacyName: string, maxAge: number): string {
    let id = this.getCookie(name) || this.getCookie(legacyName)

    if (!id) {
      id = this.generateId()
    }

    // Persist under the canonical key and remove the legacy key without changing identity.
    this.setCookie(name, id, maxAge)
    this.deleteCookie(legacyName)

    return id
  }

  private migrateStorageKey(storage: Storage, name: string, legacyName: string): void {
    try {
      const current = storage.getItem(name)
      const legacy = storage.getItem(legacyName)

      if (current === null && legacy !== null) {
        storage.setItem(name, legacy)
      }
      if (legacy !== null) {
        storage.removeItem(legacyName)
      }
    } catch (error) {
      this.log('Unable to migrate legacy browser storage', error)
    }
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    const array = new Uint8Array(16)
    crypto.getRandomValues(array)
    return Array.from(array)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  /**
   * Get cookie value
   */
  private getCookie(name: string): string | null {
    const value = `; ${document.cookie}`
    const parts = value.split(`; ${name}=`)
    if (parts.length === 2) {
      return parts.pop()?.split(';').shift() || null
    }
    return null
  }

  /**
   * Set cookie
   */
  private setCookie(name: string, value: string, maxAge: number): void {
    document.cookie = `${name}=${value};max-age=${Math.floor(maxAge / 1000)};path=/;samesite=lax`
  }

  /**
   * Delete cookie
   */
  private deleteCookie(name: string): void {
    document.cookie = `${name}=;max-age=0;path=/;samesite=lax`
  }

  /**
   * Get device information
   */
  private getDeviceInfo() {
    const ua = navigator.userAgent
    let device = 'desktop'

    if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
      device = 'tablet'
    } else if (
      /Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(
        ua
      )
    ) {
      device = 'mobile'
    }

    return {
      device,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
    }
  }

  /**
   * Get browser information
   */
  private getBrowserInfo() {
    const ua = navigator.userAgent
    let browser = 'Other'
    let os = 'Other'

    // Browser detection
    if (ua.indexOf('Firefox') > -1) browser = 'Firefox'
    else if (ua.indexOf('Opera') > -1 || ua.indexOf('OPR') > -1) browser = 'Opera'
    else if (ua.indexOf('Trident') > -1) browser = 'IE'
    else if (ua.indexOf('Edge') > -1) browser = 'Edge'
    else if (ua.indexOf('Chrome') > -1) browser = 'Chrome'
    else if (ua.indexOf('Safari') > -1) browser = 'Safari'

    // OS detection
    if (ua.indexOf('Win') > -1) os = 'Windows'
    else if (ua.indexOf('Mac') > -1) os = 'macOS'
    else if (ua.indexOf('Linux') > -1) os = 'Linux'
    else if (ua.indexOf('Android') > -1) os = 'Android'
    else if (ua.indexOf('iOS') > -1) os = 'iOS'

    return { browser, os }
  }

  /**
   * Get UTM parameters
   */
  private getUtmParams() {
    const params = new URLSearchParams(window.location.search)
    const utm: CampaignAttribution = {}

    const source =
      params.get('utm_source') || params.get('ref') || params.get('source') || params.get('via')
    if (source) utm.source = source
    ;(['medium', 'campaign', 'term', 'content'] as const).forEach((key) => {
      const value = params.get('utm_' + key)
      if (value) utm[key] = value
    })

    // Ad click IDs
    ;(['gclid', 'fbclid', 'msclkid'] as const).forEach((id) => {
      const value = params.get(id)
      if (value) utm[id] = value
    })

    const currentAttribution = Object.keys(utm).length > 0 ? utm : null
    const storageKey = this.getAttributionStorageKey()

    try {
      if (currentAttribution) {
        if (this.sessionId) {
          sessionStorage.setItem(
            storageKey,
            JSON.stringify({ sessionId: this.sessionId, attribution: currentAttribution })
          )
        }
        return currentAttribution
      }

      const stored = sessionStorage.getItem(storageKey)
      if (!stored || !this.sessionId) return null

      const parsed = JSON.parse(stored) as {
        sessionId?: unknown
        attribution?: Record<string, unknown>
      }
      if (parsed.sessionId !== this.sessionId || !parsed.attribution) return null

      const restored: CampaignAttribution = {}
      for (const key of ATTRIBUTION_KEYS) {
        const value = parsed.attribution[key]
        if (typeof value === 'string' && value) restored[key] = value
      }

      return Object.keys(restored).length > 0 ? restored : null
    } catch (error) {
      this.log('Unable to persist campaign attribution', error)
      return currentAttribution
    }
  }

  /**
   * Preserve the first external referrer for the current session.
   */
  private getSessionReferrer(): string | null {
    const currentReferrer = this.normalizeExternalReferrer(document.referrer)
    const storageKey = this.getReferrerStorageKey()

    try {
      const stored = sessionStorage.getItem(storageKey)
      if (stored && this.sessionId) {
        const parsed = JSON.parse(stored) as { sessionId?: unknown; referrer?: unknown }
        if (parsed.sessionId === this.sessionId) {
          return typeof parsed.referrer === 'string' && parsed.referrer ? parsed.referrer : null
        }
      }

      if (this.sessionId) {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ sessionId: this.sessionId, referrer: currentReferrer })
        )
      }
    } catch (error) {
      this.log('Unable to persist session referrer', error)
    }

    return currentReferrer
  }

  private normalizeExternalReferrer(value: string): string | null {
    if (!value) return null

    try {
      const referrerUrl = new URL(value, window.location.href)
      if (referrerUrl.hostname === window.location.hostname) return null
      return referrerUrl.href
    } catch {
      return value.slice(0, 2048)
    }
  }

  /**
   * Get query parameters
   */
  private getQueryParams(): Record<string, string> | null {
    const params = new URLSearchParams(window.location.search)
    const query: Record<string, string> = {}

    params.forEach((value, key) => {
      query[key] = value
    })

    return Object.keys(query).length > 0 ? query : null
  }

  /**
   * Get current page path, optionally including hash-router state.
   */
  private getCurrentPath(): string {
    return `${window.location.pathname}${this.config.trackHashRoutes ? window.location.hash : ''}`
  }

  private getAttributionStorageKey(): string {
    return `${ATTRIBUTION_STORAGE_PREFIX}${this.config.websiteId}`
  }

  private getReferrerStorageKey(): string {
    return `${REFERRER_STORAGE_PREFIX}${this.config.websiteId}`
  }

  private getConsentStorageKey(): string {
    return `${CONSENT_STORAGE_PREFIX}${this.config.websiteId}`
  }

  private getLegacyAttributionStorageKey(): string {
    return `${LEGACY_ATTRIBUTION_STORAGE_PREFIX}${this.config.websiteId}`
  }

  private getLegacyReferrerStorageKey(): string {
    return `${LEGACY_REFERRER_STORAGE_PREFIX}${this.config.websiteId}`
  }

  private getLegacyConsentStorageKey(): string {
    return `${LEGACY_CONSENT_STORAGE_PREFIX}${this.config.websiteId}`
  }

  /**
   * Check if Do Not Track is enabled
   */
  private isDoNotTrack(): boolean {
    const legacyWindow = window as Window & { doNotTrack?: string }
    const legacyNavigator = navigator as Navigator & { msDoNotTrack?: string }
    const dnt = navigator.doNotTrack || legacyWindow.doNotTrack || legacyNavigator.msDoNotTrack
    return dnt === '1' || dnt === 'yes'
  }

  /**
   * Debug logging
   */
  private log(message: string, ...args: unknown[]): void {
    if (this.config.debug) {
      console.log(`[MetricPanel] ${message}`, ...args)
    }
  }
}

/**
 * Create a new MetricPanel instance
 */
export function createMetricPanel(config: MetricPanelConfig): MetricPanelSDK {
  return new MetricPanelSDK(config)
}

function normalizeProperties(
  properties?: EventProperties,
  reservedProperties?: EventProperties
): EventProperties | undefined {
  const normalized = properties
    ? (Object.fromEntries(
        Object.entries(properties).slice(0, MAX_CUSTOM_PROPERTIES)
      ) as EventProperties)
    : {}
  const result = { ...normalized, ...reservedProperties }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * Default export for convenience
 */
export default MetricPanelSDK

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0.0.0.0' ||
    hostname.startsWith('127.')
  )
}

function normalizeCurrency(value?: string): string {
  const currency = (value ?? 'usd').toLowerCase()
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error('Revenue currency must be a three-letter ISO code')
  }
  return currency
}

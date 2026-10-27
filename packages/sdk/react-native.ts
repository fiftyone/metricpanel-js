/**
 * MetricPanel React Native SDK entrypoint.
 * DOM-free tracking helpers for React Native and other native JavaScript runtimes.
 */
import { normalizeIdentity, type IdentityTraits } from './identity'
export type { IdentityTraits } from './identity'

export interface MetricPanelNativeStorage {
  getItem(key: string): string | null | Promise<string | null>
  setItem(key: string, value: string): void | Promise<void>
  removeItem(key: string): void | Promise<void>
}

export interface MetricPanelNativeFetchResponse {
  ok: boolean
  status: number
  text?(): Promise<string>
}

export type MetricPanelNativeFetch = (
  input: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
  }
) => Promise<MetricPanelNativeFetchResponse>

export interface MetricPanelNativeConfig {
  websiteId: string
  apiUrl: string
  apiToken?: string
  debug?: boolean
  storage?: MetricPanelNativeStorage
  visitorId?: string
  sessionId?: string
  fetch?: MetricPanelNativeFetch
  userAgent?: string
  platform?: string
  os?: string
  device?: string
  screenWidth?: number
  screenHeight?: number
  cookieless?: boolean
  disableGeo?: boolean
  anonymizeIP?: boolean
  defaultProperties?: EventProperties
}

export interface EventProperties {
  [key: string]: string | number | boolean | null
}

export interface RevenueData {
  amount: number
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

export interface NativePageviewData {
  path: string
  title?: string
  referrer?: string | null
  query?: Record<string, string> | null
  utm?: NativeUtmParams
}

export interface NativeScreenData {
  path?: string
  title?: string
  referrer?: string | null
  query?: Record<string, string> | null
  utm?: NativeUtmParams
  properties?: EventProperties
}

export interface NativeUtmParams {
  source?: string
  medium?: string
  campaign?: string
  term?: string
  content?: string
  gclid?: string
  fbclid?: string
  msclkid?: string
}

export type MetricPanelNativeEventType = 'pageview' | 'event' | 'revenue' | 'goal'

const VISITOR_ID_KEY = 'mtrk_native_vid'
const SESSION_ID_KEY = 'mtrk_native_sid'
const MAX_CUSTOM_PROPERTIES = 10

export class MetricPanelNativeSDK {
  private readonly config: MetricPanelNativeConfig
  private visitorId: string | null
  private sessionId: string | null
  private initialized = false
  private initPromise: Promise<void> | null = null
  private identifiedUserId: string | null = null

  constructor(config: MetricPanelNativeConfig) {
    if (!config.websiteId || typeof config.websiteId !== 'string') {
      throw new Error('websiteId is required')
    }

    if (!config.apiUrl || typeof config.apiUrl !== 'string') {
      throw new Error('apiUrl is required for native tracking')
    }

    this.config = {
      debug: false,
      cookieless: false,
      disableGeo: false,
      anonymizeIP: false,
      ...config,
      apiUrl: trimTrailingSlash(config.apiUrl),
    }
    this.visitorId = config.visitorId ?? null
    this.sessionId = config.sessionId ?? null
  }

  async pageview(data: NativePageviewData): Promise<void> {
    if (!data?.path || typeof data.path !== 'string') {
      throw new Error('Pageview path is required')
    }

    return this.track('pageview', {
      path: normalizePath(data.path),
      title: data.title ?? null,
      referrer: data.referrer ?? null,
      query: data.query ?? null,
      utm: data.utm,
    })
  }

  async identify(userId: string, traits: IdentityTraits = {}): Promise<void> {
    const identity = normalizeIdentity(userId, traits)
    if (this.config.cookieless || !this.config.storage) return
    await this.init()
    if (this.identifiedUserId && this.identifiedUserId !== identity.userId) await this.reset()
    for (let attempt = 0; attempt < 2; attempt++) {
      const visitorId = this.visitorId
      const fetchImpl = this.config.fetch ?? globalThis.fetch
      if (!fetchImpl) throw new Error('fetch is required for native tracking')
      const response = await fetchImpl(`${this.config.apiUrl}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}` } : {}),
        },
        body: JSON.stringify({
          eventId: generateId(),
          websiteId: this.config.websiteId,
          visitorId,
          sessionId: this.sessionId,
          type: 'identify',
          path: '/',
          identity,
          timestamp: new Date().toISOString(),
        }),
      })
      if (visitorId !== this.visitorId) return
      if (response.status === 409 && attempt === 0) {
        await this.reset()
        continue
      }
      if (!response.ok) throw new Error(`MetricPanel identification failed with ${response.status}`)
      const body = response.text ? await response.text() : ''
      if (visitorId !== this.visitorId) return
      if (!body || JSON.parse(body).identified !== true)
        throw new Error('MetricPanel identification was not accepted')
      this.identifiedUserId = identity.userId
      return
    }
  }

  /** Rotate visitor and session on logout; resetSession alone does not clear account identity. */
  async reset(): Promise<void> {
    await this.init()
    this.identifiedUserId = null
    this.visitorId = generateId()
    this.sessionId = generateId()
    if (!this.config.cookieless) {
      await this.config.storage?.setItem(VISITOR_ID_KEY, this.visitorId)
      await this.config.storage?.setItem(SESSION_ID_KEY, this.sessionId)
    }
  }

  async screen(name: string, data: NativeScreenData = {}): Promise<void> {
    if (!name || typeof name !== 'string') {
      throw new Error('Screen name must be a string')
    }

    return this.track('pageview', {
      name,
      path: data.path ? normalizePath(data.path) : `/screen/${slugify(name)}`,
      title: data.title ?? name,
      referrer: data.referrer ?? null,
      query: data.query ?? null,
      utm: data.utm,
      properties: normalizeProperties(data.properties),
    })
  }

  async event(name: string, properties?: EventProperties): Promise<void> {
    if (!name || typeof name !== 'string') {
      throw new Error('Event name must be a string')
    }

    return this.track('event', {
      name,
      properties: normalizeProperties(properties),
    })
  }

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

  async goal(data: GoalData): Promise<void> {
    if (!data || typeof data.name !== 'string' || !data.name.trim()) {
      throw new Error('Goal name is required')
    }
    if (data.value !== undefined && (!Number.isSafeInteger(data.value) || data.value < 0)) {
      throw new Error('Goal value must be a non-negative integer in the smallest currency unit')
    }
    const { value: propertyValue, ...customProperties } = data.properties ?? {}
    const goalValue = data.value !== undefined ? data.value : propertyValue

    return this.track('goal', {
      name: data.name.trim(),
      properties: normalizeProperties(
        customProperties,
        goalValue !== undefined ? { value: goalValue } : undefined
      ),
    })
  }

  getStripeMetadata(): Record<string, string> {
    const metadata: Record<string, string> = {
      metricpanel_website_id: this.config.websiteId,
    }

    if (this.visitorId) metadata.metricpanel_visitor_id = this.visitorId
    if (this.sessionId) metadata.metricpanel_session_id = this.sessionId

    return metadata
  }

  getVisitorId(): string | null {
    return this.visitorId
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  async resetSession(): Promise<void> {
    this.sessionId = generateId()
    if (!this.config.cookieless) await this.config.storage?.setItem(SESSION_ID_KEY, this.sessionId)
  }

  private async init(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this.loadIdentity()
    await this.initPromise
  }

  private async loadIdentity(): Promise<void> {
    const storage = this.config.cookieless ? undefined : this.config.storage

    if (!this.visitorId) {
      this.visitorId = storage ? await storage.getItem(VISITOR_ID_KEY) : null
    }

    if (!this.sessionId) {
      this.sessionId = storage ? await storage.getItem(SESSION_ID_KEY) : null
    }

    if (!this.visitorId) {
      this.visitorId = generateId()
      await storage?.setItem(VISITOR_ID_KEY, this.visitorId)
    }

    if (!this.sessionId) {
      this.sessionId = generateId()
      await storage?.setItem(SESSION_ID_KEY, this.sessionId)
    }

    this.initialized = true
    this.log('Initialized', { visitorId: this.visitorId, sessionId: this.sessionId })
  }

  private async track(type: MetricPanelNativeEventType, data: Record<string, unknown>) {
    await this.init()

    if (!this.visitorId || !this.sessionId) {
      throw new Error('MetricPanel native SDK failed to initialize identity')
    }

    const inputProperties = data.properties as EventProperties | undefined
    const goalValue = type === 'goal' ? inputProperties?.value : undefined
    const customProperties =
      type === 'goal' && inputProperties
        ? (Object.fromEntries(
            Object.entries(inputProperties).filter(([key]) => key !== 'value')
          ) as EventProperties)
        : inputProperties
    const payload = {
      websiteId: this.config.websiteId,
      visitorId: this.visitorId,
      sessionId: this.sessionId,
      type,
      path: typeof data.path === 'string' ? data.path : '/app',
      title: data.title ?? null,
      referrer: data.referrer ?? null,
      query: data.query ?? null,
      screenWidth: this.config.screenWidth,
      screenHeight: this.config.screenHeight,
      device: this.config.device || 'mobile',
      browser: 'React Native',
      os: this.config.os || this.config.platform || 'native',
      utm: data.utm,
      timestamp: new Date().toISOString(),
      _privacyMode: {
        cookieless: this.config.cookieless || !this.config.storage,
        disableGeo: this.config.disableGeo || this.config.anonymizeIP,
        anonymizeIP: this.config.anonymizeIP,
      },
      ...data,
      properties: normalizeProperties(
        {
          platform: this.config.platform ?? null,
          app_user_agent: this.config.userAgent ?? null,
          ...this.config.defaultProperties,
          ...customProperties,
        },
        goalValue !== undefined ? { value: goalValue } : undefined
      ),
    }

    this.log('Tracking event', payload)
    await this.send(payload)
  }

  private async send(payload: Record<string, unknown>) {
    const fetchImpl = this.config.fetch ?? globalThis.fetch

    if (!fetchImpl) {
      throw new Error('fetch is required for native tracking')
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    if (this.config.apiToken) {
      headers.Authorization = `Bearer ${this.config.apiToken}`
    }

    const response = await fetchImpl(`${this.config.apiUrl}/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const details = response.text ? await response.text().catch(() => '') : ''
      throw new Error(
        `MetricPanel native event ingestion failed with ${response.status}${details ? `: ${details}` : ''}`
      )
    }

    this.log('Event sent via fetch')
  }

  private log(message: string, ...args: unknown[]): void {
    if (this.config.debug) {
      console.log(`[MetricPanel] ${message}`, ...args)
    }
  }
}

export function createMetricPanelNative(config: MetricPanelNativeConfig): MetricPanelNativeSDK {
  return new MetricPanelNativeSDK(config)
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

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'screen'
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizeCurrency(value?: string): string {
  const currency = (value ?? 'usd').toLowerCase()
  if (!/^[a-z]{3}$/.test(currency)) {
    throw new Error('Revenue currency must be a three-letter ISO code')
  }
  return currency
}

function generateId(): string {
  const crypto = globalThis.crypto

  if (crypto?.getRandomValues) {
    const array = new Uint8Array(16)
    crypto.getRandomValues(array)
    return Array.from(array)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`
}

export default MetricPanelNativeSDK

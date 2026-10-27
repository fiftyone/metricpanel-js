export interface IdentityTraits {
  name?: string | null
  email?: string | null
}

/** Keep profile fields out of arbitrary event properties and analytics logs. */
export function normalizeIdentity(userId: string, traits: IdentityTraits = {}) {
  if (typeof userId !== 'string' || !userId.trim() || userId.trim().length > 200) {
    throw new Error('Identity userId must be a non-empty string of at most 200 characters')
  }
  if (
    !traits ||
    typeof traits !== 'object' ||
    Object.keys(traits).some((key) => !['name', 'email'].includes(key))
  ) {
    throw new Error('Identity supports only name and email traits')
  }
  const identity: IdentityTraits & { userId: string } = { userId: userId.trim() }
  for (const key of ['name', 'email'] as const) {
    const value = traits[key]
    if (value === undefined) continue
    if (value === null) {
      identity[key] = null
      continue
    }
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.trim().length > (key === 'name' ? 200 : 254)
    ) {
      throw new Error(`Invalid identity ${key}`)
    }
    if (key === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))
      throw new Error('Invalid identity email')
    identity[key] = value.trim()
  }
  return identity
}

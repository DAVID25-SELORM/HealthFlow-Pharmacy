import { nehfamsAdapter } from './nehfamsAdapter.ts'

export const CCC_PROVIDERS = Object.freeze({
 existing: { live: true },
 otac: { live: true },
 nehfams: nehfamsAdapter,
})
export function requireLiveCccProvider(provider: unknown) {
 if (typeof provider !== 'string' || !Object.hasOwn(CCC_PROVIDERS, provider)) throw new Error('Unsupported CCC provider')
 if (!CCC_PROVIDERS[provider as keyof typeof CCC_PROVIDERS].live) throw new Error('NeHFAMS is not available: official API validation is pending')
 return provider as 'existing' | 'otac'
}

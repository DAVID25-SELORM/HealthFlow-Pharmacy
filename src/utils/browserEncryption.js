const ENCRYPTION_VERSION = 'hf-aes-gcm-v1'
const DEVICE_SECRET_KEY = 'healthflow.crypto.deviceSecret.v1'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const isBrowserCryptoAvailable = () =>
  typeof window !== 'undefined' &&
  Boolean(window.crypto?.subtle) &&
  Boolean(window.crypto?.getRandomValues) &&
  Boolean(window.localStorage)

const bytesToBase64 = (bytes) => {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return window.btoa(binary)
}

const base64ToBytes = (value) => {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

const getOrCreateDeviceSecret = () => {
  const existingSecret = window.localStorage.getItem(DEVICE_SECRET_KEY)
  if (existingSecret) {
    return base64ToBytes(existingSecret)
  }

  const secret = new Uint8Array(32)
  window.crypto.getRandomValues(secret)
  window.localStorage.setItem(DEVICE_SECRET_KEY, bytesToBase64(secret))
  return secret
}

const getDeviceKey = async () => {
  const secret = getOrCreateDeviceSecret()
  return await window.crypto.subtle.importKey('raw', secret, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

export const isEncryptedEnvelope = (value) =>
  Boolean(value && value.__encrypted === true && value.version === ENCRYPTION_VERSION)

export const encryptJson = async (value) => {
  if (!isBrowserCryptoAvailable()) {
    return value
  }

  const iv = new Uint8Array(12)
  window.crypto.getRandomValues(iv)
  const key = await getDeviceKey()
  const encodedPayload = textEncoder.encode(JSON.stringify(value))
  const encryptedPayload = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encodedPayload)

  return {
    __encrypted: true,
    version: ENCRYPTION_VERSION,
    iv: bytesToBase64(iv),
    payload: bytesToBase64(new Uint8Array(encryptedPayload)),
  }
}

export const decryptJson = async (value) => {
  if (!isEncryptedEnvelope(value)) {
    return value
  }

  if (!isBrowserCryptoAvailable()) {
    return null
  }

  try {
    const key = await getDeviceKey()
    const iv = base64ToBytes(value.iv)
    const payload = base64ToBytes(value.payload)
    const decryptedPayload = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, payload)
    return JSON.parse(textDecoder.decode(decryptedPayload))
  } catch (error) {
    console.warn('Unable to decrypt protected browser data:', error)
    return null
  }
}

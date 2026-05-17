const MAX_LOGO_BYTES = 750 * 1024
const MAX_SIGNATURE_BYTES = 350 * 1024

const readImageFileAsDataUrl = (file, { label = 'image', maxBytes = MAX_LOGO_BYTES } = {}) =>
  new Promise((resolve, reject) => {
    if (!file) {
      resolve('')
      return
    }

    if (!file.type?.startsWith('image/')) {
      reject(new Error(`Select a valid image file for the ${label}.`))
      return
    }

    if (file.size > maxBytes) {
      const labelStart = label.charAt(0).toUpperCase()
      reject(new Error(`${labelStart}${label.slice(1)} image must be ${Math.floor(maxBytes / 1024)}KB or smaller.`))
      return
    }

    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error(`Unable to read the selected ${label} image.`))
    reader.readAsDataURL(file)
  })

export const readLogoFileAsDataUrl = (file) =>
  readImageFileAsDataUrl(file, { label: 'pharmacy logo', maxBytes: MAX_LOGO_BYTES })

export const readSignatureFileAsDataUrl = (file) =>
  readImageFileAsDataUrl(file, { label: 'claims officer signature', maxBytes: MAX_SIGNATURE_BYTES })

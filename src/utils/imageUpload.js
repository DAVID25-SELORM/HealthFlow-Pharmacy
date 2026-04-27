const MAX_LOGO_BYTES = 750 * 1024

export const readLogoFileAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    if (!file) {
      resolve('')
      return
    }

    if (!file.type?.startsWith('image/')) {
      reject(new Error('Select a valid image file for the pharmacy logo.'))
      return
    }

    if (file.size > MAX_LOGO_BYTES) {
      reject(new Error('Logo image must be 750KB or smaller.'))
      return
    }

    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Unable to read the selected logo image.'))
    reader.readAsDataURL(file)
  })

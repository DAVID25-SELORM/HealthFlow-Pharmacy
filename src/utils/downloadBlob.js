// Hands a finished file to the browser to save.
export const downloadBlob = (blob, fileName) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.style.display = 'none'
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  // Firefox needs a moment before the link and address can be removed.
  setTimeout(() => {
    URL.revokeObjectURL(url)
    link.remove()
  }, 1000)
}

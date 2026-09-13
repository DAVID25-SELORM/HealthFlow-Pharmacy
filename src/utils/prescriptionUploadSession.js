// Form-local cache: retain only the selected file's successful upload so a
// failed claim save can be retried without retransmitting the prescription.
export const createPrescriptionUploadSession = () => {
  let current = null
  return {
    clear() { current = null },
    upload(file, scope, upload) {
      const key = JSON.stringify(scope)
      if (current?.file === file && current.key === key) return current.promise
      const entry = { file, key, promise: null }
      entry.promise = Promise.resolve().then(() => upload(file, scope)).catch((error) => {
        if (current === entry) current = null
        throw error
      })
      current = entry
      return entry.promise
    },
  }
}

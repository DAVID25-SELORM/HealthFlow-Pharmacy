// Reuse only an explicit organization-level saved pair; never environment or branch credentials.
export async function resolveNehfamsCredentials({ key, secret, configured, loadSaved, decode }: any) {
 if (key || secret || configured) return { key, secret }
 const saved = await loadSaved()
 if (!saved?.api_key_encrypted || !saved?.api_secret_encrypted) throw new Error('Save this facility?s NHIA API key and secret first, or enter both NeHFAMS credentials.')
 const reusedKey = await decode(saved.api_key_encrypted)
 const reusedSecret = await decode(saved.api_secret_encrypted)
 if (!reusedKey || !reusedSecret) throw new Error('Saved NHIA credentials could not be read. Re-enter this facility?s credentials.')
 return { key: reusedKey, secret: reusedSecret }
}

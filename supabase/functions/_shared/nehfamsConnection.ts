import { NEHFAMS_ORIGINS, NEHFAMS_PATHS, validateNehfamsFacility, fetchNehfamsFacility, field } from './nehfamsAdapter.ts'
export async function discoverNehfamsFacility({environment,key,secret,fetcher=fetch}: any) {
 if (!['test','production'].includes(environment)) throw new Error('Select a NeHFAMS environment.')
 if (!key || !secret) throw new Error('Enter both API credentials or leave both blank to reuse the saved pair.')
 let body
 try { body=await fetchNehfamsFacility({environment,apiKey:key,apiSecret:secret,fetcher}) }
 catch { throw new Error('Could not get facility details from NHIA. Check the credentials, environment and connection.') }
 const hpn=field(body,'HPN'), name=field(body,'HPName')
 if(typeof hpn!=='string' || !hpn.trim() || typeof name!=='string' || !name.trim()) throw new Error('NHIA returned incomplete facility details.')
 const facility=validateNehfamsFacility(body,{hpn,name})
 return {expectedHpn:facility.hpn,expectedFacilityName:facility.name}
}
export async function readNehfamsConnection(db: any, org: string, environment: string) {
 if (!['test','production'].includes(environment)) throw new Error('Select a NeHFAMS environment.')
 const {data,error}=await db.from('organization_nehfams_connection').select('*').eq('organization_id',org).eq('environment',environment).maybeSingle()
 if(error) throw new Error('Unable to read NeHFAMS configuration.')
 return data
}
export function publicNehfamsConnection(c: any) {
 return c ? {environment:c.environment,expectedHpn:c.expected_hpn || '',expectedFacilityName:c.expected_name || '',validatedAt:c.validated_at,authMode:c.auth_mode,otacRequired:c.otac_required,configured:true,validated:!!c.validated_at && c.validated_version===c.version && Number.isFinite(Date.parse(c.validated_at))} : null
}
export async function validateSavedNehfamsConnection({db,org,actor,environment,decode,fetcher=fetch}: any) {
 const c=await readNehfamsConnection(db,org,environment)
 if(!c) throw new Error('Save credentials for this environment first.')
 let key, secret
 try {
  key=await decode(c.api_key_encrypted); secret=await decode(c.api_secret_encrypted)
 } catch { throw new Error('Saved NeHFAMS credentials could not be read. Save the facility API key and secret again.') }
 if(!key || !secret || /[\r\n]/.test(key+secret)) throw new Error('Saved NeHFAMS credentials are invalid. Save both the API key and secret again.')
 let response
 try {
  response=await fetcher(NEHFAMS_ORIGINS[environment as keyof typeof NEHFAMS_ORIGINS]+NEHFAMS_PATHS.facility,{method:'GET',redirect:'error',headers:{'x-nhia-apikey':key,'x-nhia-apisecret':secret,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)})
 } catch (error) {
  if(error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)) throw new Error('NHIA facility validation timed out. No attendance was requested. Try validation again.')
  throw new Error('Could not reach NHIA for facility validation. No attendance was requested. Check connectivity and try validation again.')
 }
 if(!response.ok) {
  if([401,403].includes(response.status)) throw new Error('NHIA rejected the saved API credentials or access permission. Confirm this facility API account is authorized for the selected environment, then save its API key and secret.')
  throw new Error(`NHIA facility validation returned HTTP ${Number.isInteger(response.status)?response.status:'error'}. No attendance was requested. Contact NHIA if this continues.`)
 }
 let body
 try { body=await response.json() } catch { throw new Error('NHIA facility validation returned invalid JSON. No attendance was requested. Contact NHIA if this continues.') }
 const facility=validateNehfamsFacility(body,{hpn:c.expected_hpn,name:c.expected_name})
 const {error}=await db.rpc('validate_nehfams_connection',{p_org:org,p_actor:actor,p_environment:environment,p_version:c.version,p_mode:facility.authMode,p_otac:facility.otacRequired})
 if(error) throw new Error('Connection changed or validation could not be recorded. Validate again.')
 return facility
}

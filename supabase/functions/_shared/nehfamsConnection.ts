import { NEHFAMS_ORIGINS, NEHFAMS_PATHS, validateNehfamsFacility } from './nehfamsAdapter.ts'
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
 let body
 try {
  const key=await decode(c.api_key_encrypted), secret=await decode(c.api_secret_encrypted)
  if(!key || !secret || /[\r\n]/.test(key+secret)) throw new Error('Invalid credentials')
  const response=await fetcher(NEHFAMS_ORIGINS[environment as keyof typeof NEHFAMS_ORIGINS]+NEHFAMS_PATHS.facility,{method:'GET',redirect:'error',headers:{'x-nhia-apikey':key,'x-nhia-apisecret':secret,'Content-Type':'application/json'},signal:AbortSignal.timeout(15000)})
  if(!response.ok) throw new Error('Rejected')
  body=await response.json()
 } catch { throw new Error('NeHFAMS connection validation failed. Check credentials and connectivity.') }
 const facility=validateNehfamsFacility(body,{hpn:c.expected_hpn,name:c.expected_name})
 const {error}=await db.rpc('validate_nehfams_connection',{p_org:org,p_actor:actor,p_environment:environment,p_version:c.version,p_mode:facility.authMode,p_otac:facility.otacRequired})
 if(error) throw new Error('Connection changed or validation could not be recorded. Validate again.')
 return facility
}

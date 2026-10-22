import { readNehfamsConnection, publicNehfamsConnection } from './nehfamsConnection.ts'
import { requireLiveCccProvider, prepareNehfamsAttendance, sendNehfamsAttendance, mapNehfamsAttendance, fetchNehfamsFacility, validateNehfamsFacility, NehfamsOutcomeError } from './nehfamsAdapter.ts'
import { normalizeAttendanceNewCcc } from '../../../src/utils/nhiaAttendanceValues.js'
// No patient data or credentials may be logged by this module.
export const OTAC_URL = 'https://otac.nhia.gov.gh/api/attendance/generate'
const text = (v: unknown) => typeof v === 'string' ? v.trim() : ''
const facilityKey = (v: unknown) => text(v).toUpperCase().replace(/\s+/g, ' ')

export class CccFailure extends Error {
 // `rejected` means NHIA explicitly refused the request, so no attendance exists and a retry is safe.
 constructor(public code: string, message: string, public rejected = false) { super(message) }
}
const timedOut = (error: unknown) => error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)

export function inspectOtacToken(value: unknown, expectedHpn: string, now = Date.now()) {
 const token = text(value).replace(/^Bearer\s+/i, '')
 if (!token || token.split('.').length !== 3 || /\s/.test(token) || token.length > 16000) throw new Error('Enter a valid OTAC Bearer token')
 let claims
 try { claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) } catch { throw new Error('Invalid OTAC token format') }
 // Decoding is a preflight check, not signature verification. NHIA authenticates the token.
 if (!Number.isFinite(claims?.exp) || claims.exp * 1000 <= now + 60000) throw new Error('OTAC token has expired or expires within one minute')
 if (!expectedHpn || String(claims.HPN) !== expectedHpn) throw new Error('Token HPN does not match the configured facility HPN')
 return { token, expiresAt: new Date(claims.exp * 1000).toISOString() }
}

export function mapOtacResponse(body: any, expectedName: string, attendanceDate: string) {
 if (body?.statusCode !== 0 || !body?.attendanceData) throw new CccFailure('otac_attendance_unconfirmed', 'NHIA did not confirm attendance.')
 const d = body.attendanceData
 if (facilityKey(d.hpName) !== facilityKey(expectedName)) throw new CccFailure('otac_facility_mismatch', 'NHIA returned an unexpected facility.')
 if (!/^\d{5}$/.test(String(d.ccc || '')) || !text(d.authID) || text(d.attendanceDate).slice(0,10) !== attendanceDate) throw new CccFailure('otac_invalid_attendance', 'NHIA returned incomplete attendance or an unexpected date.')
 const memberDetails = { ccCode:String(d.ccc), hin:text(d.hin), memberName:text(d.memberName), gender:text(d.gender), dateOfBirth:text(d.dob).slice(0,10), eligibilityStartDate:text(d.startDate).slice(0,10), eligibilityEndDate:text(d.endDate).slice(0,10), attendanceDate, authId:text(d.authID), authType:text(d.attendanceType), newCcc:normalizeAttendanceNewCcc(d.newCCC), hpName:text(d.hpName), attendanceVerificationSource:'otac_api', attendanceVerificationStatus:'confirmed' }
 return { ok:true, ccCode:String(d.ccc), source:'otac', memberDetails }
}

export async function getCccPolicy(db: any, org: string) {
 const {data,error} = await db.from('organization_ccc_policy').select('*').eq('organization_id',org).maybeSingle()
 if(error) throw new Error('CCC policy is unavailable. Check deployment before generating attendance.')
 if(data?.provider==='nehfams') data.nehfams=publicNehfamsConnection(await readNehfamsConnection(db,org,data.environment || 'production'))
 return data || {organization_id:org,provider:'existing',enabled:true,version:0}
}

export function publicCccPolicy(p: any) {
 return {nehfams:p.nehfams || null,environment:p.environment || 'production',provider:p.provider, enabled:p.enabled, expectedHpn:p.expected_hpn || '', expectedFacilityName:p.expected_facility_name || '', hasToken:!!p.token_encrypted, tokenExpiresAt:p.token_expires_at || null, version:p.version,
 status:p.provider==='nehfams'?(p.nehfams?.validated && p.enabled?(p.environment==='production'?'production_configured':'test_configured'):'validation_pending'):!p.enabled?'disabled':p.provider==='existing'?'existing_configuration':!p.token_encrypted?'needs_token':!Number.isFinite(Date.parse(p.token_expires_at)) || Date.parse(p.token_expires_at)<=Date.now()+60000?'needs_renewal':'configured', updatedAt:p.updated_at}
}

export async function runCccRequest({db,org,actor,branch,payload,decode,existing,preflightExisting,fetcher=fetch,allowNehfamsTest=false,allowNehfamsProduction=false}: any) {
 const member = text(payload.memberNumber || payload.memberNo).toUpperCase()
 const card = text(payload.cardType) || (member.startsWith('GHA-')?'GHANACARD':'NHISCARD')
 if (card==='NHISCARD' ? !/^\d{8,}$/.test(member) : card!=='GHANACARD' || !/^GHA-\d{9}-\d$/.test(member)) throw new Error('Enter a valid membership number and card type')
 const date = text(payload.serviceDate).slice(0,10) || new Date().toISOString().slice(0,10)
 const policy = await getCccPolicy(db,org)
 requireLiveCccProvider(policy.provider,allowNehfamsTest,policy.environment,allowNehfamsProduction)
 if(!policy.enabled) throw new Error('CCC generation is disabled for this facility')
 const {data:reservation,error} = await db.rpc('reserve_ccc_attendance',{p_org:org,p_actor:actor,p_branch:branch || null,p_encounter:text(payload.claimId || payload.claim_id) || `attendance:${member}:${date}`,p_member:member,p_card:card,p_date:date})
 if(error) throw new Error(error.message)
 if(reservation.cached) return {...reservation.result, environment:reservation.environment || policy.environment || 'production', memberDetails:{...reservation.result?.memberDetails,attendanceRequestId:reservation.request_id}, reused:true, attendanceRequestId:reservation.request_id}
 const snapshot = reservation.policy
 let result
 let dispatched = false
 try {
  const provider = requireLiveCccProvider(snapshot.provider,allowNehfamsTest,snapshot.environment,allowNehfamsProduction)
  if(provider==='nehfams') {
   const connection=reservation.connection
   const environment=snapshot.environment
   if(!['test','production'].includes(environment) || !connection || connection.organization_id!==org || connection.environment!==environment || connection.validated_version!==connection.version || !connection.validated_at || !Number.isFinite(Date.parse(connection.validated_at))) throw new Error('NeHFAMS connection needs validation')
   const apiKey=await decode(connection.api_key_encrypted), apiSecret=await decode(connection.api_secret_encrypted)
   // NHIA turns OTAC and the authentication mode on and off during its rollout, so the saved copy is not trusted.
   // This read-only lookup happens before anything is dispatched: any failure here creates no attendance and is retryable.
   let facility
   try { facility=validateNehfamsFacility(await fetchNehfamsFacility({environment,apiKey,apiSecret,fetcher}),{hpn:connection.expected_hpn,name:connection.expected_name}) }
   catch(error) {
    const message=error instanceof Error && /^(NeHFAMS facility identity mismatch|Unsupported NeHFAMS authentication|NeHFAMS authentication requires)/.test(error.message) ? error.message : 'Could not confirm the facility settings with NHIA.'
    throw new CccFailure('nehfams_facility_check_failed',`${message} No attendance was requested.`,true)
   }
   if(facility.otacRequired && !/^\d{4}$/.test(text(payload.otacCode))) throw new CccFailure('nehfams_otac_required','NHIA currently requires the four-digit OTAC from the NHIS client. Enter it and try again. No attendance was requested.',true)
   const request=prepareNehfamsAttendance({environment,apiKey,apiSecret,cardType:card,cardNo:member,otac:text(payload.otacCode),facility})
   dispatched=true
   result=mapNehfamsAttendance(await sendNehfamsAttendance(request,fetcher),{facilityName:connection.expected_name,date,cardType:card,cardNo:member})
   result.environment=environment
  } else if(provider==='otac') {
   const {token} = inspectOtacToken(await decode(snapshot.token_encrypted),snapshot.expected_hpn)
   dispatched = true
   let response
   try { response = await fetcher(OTAC_URL,{method:'POST',redirect:'error',headers:{Accept:'application/json','Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({cardType:card,cardNo:member,otac:text(payload.otacCode)||null,bioMatchResult:null,bmasTransactionID:null}),signal:AbortSignal.timeout(25000)}) } catch (error) {
    throw new CccFailure(timedOut(error)?'otac_timeout':'otac_network_error', timedOut(error)?'OTAC request timed out.':'Could not receive a response from OTAC.')
   }
   if(!response.ok) throw new CccFailure(
    response.status===401 || response.status===403 ? 'otac_auth_rejected' : `otac_http_${response.status}`,
    response.status===401 || response.status===403 ? 'OTAC rejected the facility token.' : `OTAC returned HTTP ${response.status}.`)
   let body
   try { body = await response.json() } catch (error) {
    throw new CccFailure(timedOut(error)?'otac_timeout':'otac_invalid_response', timedOut(error)?'OTAC response timed out.':'OTAC returned an unreadable response.')
   }
   result = mapOtacResponse(body,snapshot.expected_facility_name,date)
  } else {
   await preflightExisting()
   result = await existing({...payload,memberNumber:member,cardType:card}, () => { dispatched = true })
   if(result?.eligibilityError) throw new CccFailure('existing_member_rejected', text(result.eligibilityError).slice(0,200) || 'NHIA did not issue a CCC for this member.', true)
   if(!result?.ccCode && result?.ok !== false) throw new CccFailure('existing_no_code_issued', 'NHIA did not issue a CCC for this member number. Check the NHIS number and card type, then try again.', true)
   if(!result?.ccCode || !/^\d{5}$/.test(result.ccCode)) throw new CccFailure('existing_attendance_unconfirmed', 'NHIA did not confirm a valid attendance code.')
   if(snapshot.expected_facility_name && facilityKey(result.memberDetails?.hpName)!==facilityKey(snapshot.expected_facility_name)) throw new CccFailure('existing_facility_mismatch', 'NHIA returned an unexpected facility.')
   if(result.memberDetails?.attendanceDate && result.memberDetails.attendanceDate.slice(0,10)!==date) throw new CccFailure('existing_attendance_date_mismatch', 'NHIA returned an unexpected attendance date.')
   // Never persist the unrestricted upstream payload in the ledger.
   const {raw: _raw, ...memberDetails} = result.memberDetails || {}
   result = {ok:true,ccCode:result.ccCode,source:'api',memberDetails}
  }
  result.attendanceRequestId=reservation.request_id
  result.memberDetails={...result.memberDetails,attendanceRequestId:reservation.request_id}
  const saved = await db.from('ccc_attendance_requests').update({status:'succeeded',result,updated_at:new Date().toISOString()}).eq('id',reservation.request_id).eq('status','pending').select('id').single()
  if(saved.error || !saved.data) throw new CccFailure('attendance_recording_failed', 'Attendance generated but recording failed.')
  return result
 } catch(error) {
  // NeHFAMS StatusCode 1 is an explicit application-level refusal. It is
  // safe to retry and must not strand the member behind an unknown outcome.
  // Transport failures and malformed responses remain unresolved because NHIA
  // may have created attendance before the response was lost.
  const rejected = (error instanceof CccFailure && error.rejected) ||
    (error instanceof NehfamsOutcomeError && error.code === 'application_failure')
  try { await db.from('ccc_attendance_requests').update({status:dispatched&&!rejected?'unknown':'not_created',error_code:rejected?error.code:dispatched?(error instanceof CccFailure || error instanceof NehfamsOutcomeError?error.code:'reconciliation_required'):'preflight_failed',updated_at:new Date().toISOString()}).eq('id',reservation.request_id).eq('status','pending') } catch {
   // The original reservation remains durable; preserve its reference even if the outcome write fails.
  }
  if(rejected) throw new Error(error.message)
  if(!dispatched) throw new Error('CCC configuration needs attention. No request was sent to NHIA.')
  // No automatic fallback, retransmission, or raw upstream exception disclosure.
  throw new Error(`${error instanceof CccFailure ? error.message + ' ' : error instanceof NehfamsOutcomeError ? 'NHIA response check: ' + error.code + '. ' : ''}Attendance outcome is unresolved. Ask the platform administrator to reconcile before retrying. Request: ${reservation.request_id}`)
 }
}

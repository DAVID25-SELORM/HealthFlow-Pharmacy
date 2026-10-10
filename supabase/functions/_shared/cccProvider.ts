// No patient data or credentials may be logged by this module.
export const OTAC_URL = 'https://otac.nhia.gov.gh/api/attendance/generate'
const text = (v: unknown) => typeof v === 'string' ? v.trim() : ''
const facilityKey = (v: unknown) => text(v).toUpperCase().replace(/\s+/g, ' ')

class CccFailure extends Error {
 constructor(public code: string, message: string) { super(message) }
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
 const memberDetails = { ccCode:String(d.ccc), hin:text(d.hin), memberName:text(d.memberName), gender:text(d.gender), dateOfBirth:text(d.dob).slice(0,10), eligibilityStartDate:text(d.startDate).slice(0,10), eligibilityEndDate:text(d.endDate).slice(0,10), attendanceDate, authId:text(d.authID), authType:text(d.attendanceType), newCcc:d.newCCC, hpName:text(d.hpName), attendanceVerificationSource:'otac_api', attendanceVerificationStatus:'verified' }
 return { ok:true, ccCode:String(d.ccc), source:'otac', memberDetails }
}

export async function getCccPolicy(db: any, org: string) {
 const {data,error} = await db.from('organization_ccc_policy').select('*').eq('organization_id',org).maybeSingle()
 if(error) throw new Error('CCC policy is unavailable. Check deployment before generating attendance.')
 return data || {organization_id:org,provider:'existing',enabled:true,version:0}
}

export function publicCccPolicy(p: any) {
 return {provider:p.provider, enabled:p.enabled, expectedHpn:p.expected_hpn || '', expectedFacilityName:p.expected_facility_name || '', hasToken:!!p.token_encrypted, tokenExpiresAt:p.token_expires_at || null, version:p.version,
 status:!p.enabled?'disabled':p.provider==='existing'?'existing_configuration':!p.token_encrypted?'needs_token':!Number.isFinite(Date.parse(p.token_expires_at)) || Date.parse(p.token_expires_at)<=Date.now()+60000?'needs_renewal':'configured', updatedAt:p.updated_at}
}

export async function runCccRequest({db,org,actor,branch,payload,decode,existing,preflightExisting,fetcher=fetch}: any) {
 const member = text(payload.memberNumber || payload.memberNo).toUpperCase()
 const card = text(payload.cardType) || (member.startsWith('GHA-')?'GHANACARD':'NHISCARD')
 if (card==='NHISCARD' ? !/^\d{8,}$/.test(member) : card!=='GHANACARD' || !/^GHA-\d{9}-\d$/.test(member)) throw new Error('Enter a valid membership number and card type')
 const date = text(payload.serviceDate).slice(0,10) || new Date().toISOString().slice(0,10)
 const policy = await getCccPolicy(db,org)
 if(!policy.enabled) throw new Error('CCC generation is disabled for this facility')
 const {data:reservation,error} = await db.rpc('reserve_ccc_attendance',{p_org:org,p_actor:actor,p_branch:branch || null,p_encounter:text(payload.claimId || payload.claim_id) || `attendance:${member}:${date}`,p_member:member,p_card:card,p_date:date})
 if(error) throw new Error(error.message)
 if(reservation.cached) return {...reservation.result, reused:true, attendanceRequestId:reservation.request_id}
 const snapshot = reservation.policy
 let result
 let dispatched = false
 try {
  if(snapshot.provider==='otac') {
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
   dispatched = true
   result = await existing({...payload,memberNumber:member,cardType:card})
   if(!result?.ccCode || !/^\d{5}$/.test(result.ccCode)) throw new Error('NHIA attendance was not confirmed. Reconcile before retrying.')
   if(snapshot.expected_facility_name && facilityKey(result.memberDetails?.hpName)!==facilityKey(snapshot.expected_facility_name)) throw new Error('NHIA returned an unexpected facility. Reconciliation is required.')
   if(result.memberDetails?.attendanceDate && result.memberDetails.attendanceDate!==date) throw new Error('NHIA attendance date differs from the encounter. Reconciliation is required.')
   // Never persist the unrestricted upstream payload in the ledger.
   const {raw: _raw, ...memberDetails} = result.memberDetails || {}
   result = {ok:true,ccCode:result.ccCode,source:'api',memberDetails}
  }
  result.attendanceRequestId=reservation.request_id
  const saved = await db.from('ccc_attendance_requests').update({status:'succeeded',result,updated_at:new Date().toISOString()}).eq('id',reservation.request_id).eq('status','pending').select('id').single()
  if(saved.error || !saved.data) throw new CccFailure('attendance_recording_failed', 'Attendance generated but recording failed.')
  return result
 } catch(error) {
  await db.from('ccc_attendance_requests').update({status:dispatched?'unknown':'not_created',error_code:dispatched?(error instanceof CccFailure?error.code:'reconciliation_required'):'preflight_failed',updated_at:new Date().toISOString()}).eq('id',reservation.request_id).eq('status','pending')
  if(!dispatched) throw new Error('CCC configuration needs attention. No request was sent to NHIA.')
  // No automatic fallback, retransmission, or raw upstream exception disclosure.
  throw new Error(`${error instanceof CccFailure ? error.message + ' ' : ''}Attendance outcome is unresolved. Ask the platform administrator to reconcile before retrying. Request: ${reservation.request_id}`)
 }
}

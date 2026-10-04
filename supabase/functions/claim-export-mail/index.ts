import { createClient } from 'npm:@supabase/supabase-js@2'
import nodemailer from 'npm:nodemailer@9'
// Invoke from a trusted scheduler only. Never expose this secret or SMTP credentials to React.
Deno.serve(async (req: Request) => {
 const secret = Deno.env.get('EXPORT_MAIL_WORKER_SECRET')
 if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return new Response('Unauthorized', { status: 401 })
 if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
 const host=Deno.env.get('SMTP_HOSTNAME') || Deno.env.get('SMTP_HOST')
 const user=Deno.env.get('SMTP_USERNAME') || Deno.env.get('SMTP_USER')
 const pass=Deno.env.get('SMTP_PASSWORD') || Deno.env.get('SMTP_PASS')
 const from=Deno.env.get('SMTP_FROM')
 if (!host || !user || !pass || !from) return Response.json({ error: 'SMTP secrets are not configured; queue unchanged.' }, { status: 503 })
 const db=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
 const transport=nodemailer.createTransport({host,port:465,secure:true,auth:{user,pass},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:30000})
 const {data:jobs,error}=await db.rpc('claim_export_mail_batch')
 if(error)return Response.json({error:'Could not lease email queue.'},{status:500})
 let sent=0,failed=0
 for(const job of jobs || []){
  let success=false
  try {
   await transport.sendMail({from,to:job.recipient,subject:`HealthFlow: ${String(job.facility).replace(/[\r\n]/g,' ')} claims export ${job.period.slice(0,7)}`,
    messageId:`<claim-export-${job.id}@healthflowcloud.com>`,
    text:`A CXF claims export was generated and its audit completed.\n\nFacility: ${job.facility}\nClaims month: ${job.period.slice(0,7)}\nClaims: ${job.claim_count}\nRecorded at: ${job.exported_at}\n\nThis confirms file generation, not NHIA acceptance or receipt of the download. No patient details are included.\nOpen HealthFlow: https://healthflowcloud.com\n`})
   success=true;sent++
  }catch(error){failed++;console.error('Export notification SMTP failure', {jobId:job.id,code:error?.code,responseCode:error?.responseCode,command:error?.command})}
  const finished=await db.rpc('finish_claim_export_mail',{p_id:job.id,p_lease:job.lease,p_success:success})
  if(finished.error) console.error('Export notification acknowledgement failed',{jobId:job.id})
 }
 transport.close()
 return Response.json({sent,failed})
})

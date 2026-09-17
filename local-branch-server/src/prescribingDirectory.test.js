// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { expect,it } from 'vitest'
it('searches aliases before limiting, excludes inactive, rejects branch directory edits and preserves snapshots',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'healthflow-directory-'))
 const moduleUrl=pathToFileURL(path.resolve('local-branch-server/src/offlineRecordsRepository.js')).href
 const dbUrl=pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
 const script=`
 const {importOfflineRecords,listOfflineRecords,saveOfflineRecord,getOfflineRecord}=await import(${JSON.stringify(moduleUrl)});
 const {closeDatabase}=await import(${JSON.stringify(dbUrl)});
 const rows=Array.from({length:50},(_,i)=>({id:'shared-'+i,facility_name:'Hospital '+i,is_shared:true,status:'active',aliases:[]}));
 rows[45].aliases=['Ridge'];rows[45].nhis_enabled=true;
 rows[46].status='inactive';rows[46].aliases=['Ridge'];
 importOfflineRecords('nhis_prescribing_facilities',rows);
 const result=listOfflineRecords('nhis_prescribing_facilities',{directory:'true',searchTerm:'Ridge',nhisOnly:'true'});
 let blocked=false;try {saveOfflineRecord('nhis_prescribing_facilities',{id:'shared-45',facility_name:'Tampered'});}catch {blocked=true;}
 saveOfflineRecord('nhis_claims',{id:'claim',status:'draft',prescribing_facility_id:'shared-45',prescribing_facility_name_snapshot:'Hospital 45'});
 importOfflineRecords('nhis_prescribing_facilities',[{...rows[45],facility_name:'Renamed',status:'inactive'}]);
 console.log(JSON.stringify({ids:result.map(r=>r.id),blocked,name:getOfflineRecord('nhis_claims','claim').prescribing_facility_name_snapshot,privateCount:listOfflineRecords('nhis_prescribing_facilities').length}));
 closeDatabase();`
 try {
  const out=execFileSync(process.execPath,['--input-type=module','--eval',script],{cwd:path.resolve('local-branch-server'),env:{...process.env,HEALTHFLOW_DB_PATH:path.join(directory,'branch.sqlite')},encoding:'utf8'})
  expect(JSON.parse(out.trim().split(/\r?\n/).at(-1))).toEqual({ids:['shared-45'],blocked:true,name:'Hospital 45',privateCount:0})
 }finally{fs.rmSync(directory,{recursive:true,force:true})}
})

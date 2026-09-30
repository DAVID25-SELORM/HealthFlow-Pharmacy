// @vitest-environment node
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
it('adds CCC and folder search without replacing existing function behavior', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create table nhis_claims(id int, hin text, ccc_no text, folder_no text);
      insert into nhis_claims values(1,'MEMBER1','28058','FOLDER7');
      create function get_nhis_claims_page(integer,integer,text,boolean,date,date,text,boolean)
      returns setof int language sql stable security invoker as $$
      select c.id from nhis_claims c cross join (select $7 as search_filter) p
      where p.search_filter is null or c.hin ilike '%' || p.search_filter || '%' $$;`)
    const sql = readFileSync('supabase/migrations/20260930150000_search_nhis_ccc_and_folder.sql','utf8')
    await db.exec(sql); await db.exec(sql)
    for (const term of ['28058', 'FOLDER7', 'MEMBER1']) {
      expect((await db.query('select * from get_nhis_claims_page(1,10,null,false,null,null,$1,true)', [term])).rows).toHaveLength(1)
    }
    expect((await db.query('select * from get_nhis_claims_page(1,10,null,false,null,null,$1,true)', ['unknown'])).rows).toHaveLength(0)
  } finally { await db.close() }
},60000)

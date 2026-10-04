import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi } from 'vitest'
import BillingArrears from './BillingArrears'
import { supabase } from '../lib/supabase'
vi.mock('../lib/supabase',()=>({supabase:{rpc:vi.fn()}}))
it('previews and saves arrears, updates billing and prevents a repeated click',async()=>{
 const onSaved=vi.fn();supabase.rpc.mockResolvedValue({data:{invoices:[]}})
 render(<BillingArrears facility={{id:'org',name:'Test facility'}} onSaved={onSaved} />)
 fireEvent.click(screen.getByText('Record previous outstanding charges'))
 for(const [label,value] of [['First unpaid year','2021'],['First unpaid month','02'],['Unpaid months','2'],['Amount owed per month (GHS)','200'],['Arrears due date','2021-03-05'],['Reason for arrears','Verified unpaid']])fireEvent.change(screen.getByLabelText(label),{target:{value}})
 expect(screen.getByText('GHS 400.00')).toBeVisible()
 fireEvent.click(screen.getByRole('checkbox'))
 fireEvent.click(screen.getByRole('button',{name:'Save previous outstanding charges'}))
 await waitFor(()=>expect(onSaved).toHaveBeenCalledWith({invoices:[]}))
 expect(supabase.rpc).toHaveBeenCalledWith('platform_billing_arrears',{p_data:{organization_id:'org',first_month:'2021-02-01',months:2,monthly_amount:'200',due_on:'2021-03-05',note:'Verified unpaid'}})
 expect(screen.getByRole('button',{name:'Charges recorded'})).toBeDisabled()
})

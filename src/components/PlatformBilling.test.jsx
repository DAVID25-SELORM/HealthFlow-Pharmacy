import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import PlatformBilling from './PlatformBilling'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
vi.mock('../context/AuthContext', () => ({ useAuth: vi.fn() }))
vi.mock('../lib/supabase', () => ({ supabase: { rpc: vi.fn() } }))
const data = {
 recipient: { number: '0247654381', name: 'David Selorm Gabion' },
 facilities: [{ id: 'org', name: 'Test Pharmacy', amount: 250, starts_on: '2026-10-01', due_day: 5 }],
 invoices: [{ id: 'invoice', organization_id: 'org', facility: 'Test Pharmacy', period: '2026-10-01', due_on: '2026-10-05', amount: 250, paid_at: null }],
 payments: []
}
beforeEach(() => { vi.clearAllMocks(); useAuth.mockReturnValue({ role: 'super_admin' }); supabase.rpc.mockResolvedValue({ data }) })
async function open() { render(<PlatformBilling />); await screen.findByText(/GHS 250.00 outstanding/); fireEvent.click(screen.getByRole('button', { name: 'View billing / Pay' })) }
describe('billing panel', () => {
 it('submits historical receipt details to the protected history endpoint', async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Facility'), { target: { value: 'org' } })
  fireEvent.click(screen.getByText('Record a payment already received'))
  fireEvent.change(screen.getByLabelText('First year covered'), { target: { value: '2020' } })
  fireEvent.change(screen.getByLabelText('First month covered'), { target: { value: '01' } })
  fireEvent.change(screen.getByLabelText('Number of months covered'), { target: { value: '3' } })
  fireEvent.change(screen.getByLabelText('Amount paid per month (GHS)'), { target: { value: '100' } })
  fireEvent.change(screen.getByLabelText('Payment received on'), { target: { value: '2020-01-05' } })
  fireEvent.change(screen.getByLabelText('Transaction or receipt reference'), { target: { value: 'OLD-1234' } })
  fireEvent.change(screen.getByLabelText('Verification note'), { target: { value: 'Matched statement' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /I verified this receipt/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Record confirmed payment' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('platform_billing_record_history', { p_data: { organization_id: 'org', first_month: '2020-01-01', months: 3, monthly_amount: '100', received_on: '2020-01-05', reference: 'OLD-1234', note: 'Matched statement' } }))
 })
 it('offers a visible month calendar and submits the chosen month', async () => {
  supabase.rpc.mockResolvedValue({ data: { ...data, facilities: [{ id: 'org', name: 'Test Pharmacy' }] } })
  await open()
  fireEvent.change(screen.getByLabelText('Facility'), { target: { value: 'org' } })
  const nextYear = new Date().getUTCFullYear() + 1
  fireEvent.change(screen.getByLabelText('Year'), { target: { value: String(nextYear) } })
  fireEvent.click(screen.getByRole('button', { name: `January ${nextYear}` }))
  expect(screen.getByRole('button', { name: `January ${nextYear}` })).toHaveAttribute('aria-pressed', 'true')
  fireEvent.change(screen.getByLabelText('Monthly amount (GHS)'), { target: { value: '200' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save monthly charge' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('platform_billing', expect.objectContaining({ p_action: 'set_plan', p_data: expect.objectContaining({ starts_on: `${nextYear}-01-01`, amount: '200' }) })))
 })
 it('loads the selected facility plan and saves its charge', async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Facility'), { target: { value: 'org' } })
  expect(screen.getByLabelText('Monthly amount (GHS)')).toHaveValue(250)
  expect(screen.getByLabelText('Due day (1-28)')).toHaveValue(5)
  fireEvent.click(screen.getByRole('button', { name: 'Save monthly charge' }))
  await waitFor(() => expect(supabase.rpc).toHaveBeenCalledWith('platform_billing', expect.objectContaining({ p_action: 'set_plan', p_data: expect.objectContaining({ organization_id: 'org', amount: '250', due_day: 5 }) })))
 })
 it('shows MoMo instructions and prevents another submission while pending', async () => {
  useAuth.mockReturnValue({ role: 'admin' })
  supabase.rpc.mockResolvedValue({ data: { ...data, payments: [{ id: 'p', invoice_id: 'invoice', amount: 250, status: 'pending', transaction_reference: 'MOMO123' }] } })
  await open()
  expect(screen.getByText('0247654381')).toBeInTheDocument()
  expect(screen.getByText('David Selorm Gabion')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /I have paid/ })).not.toBeInTheDocument()
  expect(screen.getByText(/Do not pay this invoice again/)).toBeInTheDocument()
 })
 it('filters paid invoices without hiding the billing controls', async () => {
  await open()
  fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'paid' } })
  expect(screen.getByText('No invoices to show')).toBeInTheDocument()
  expect(screen.getByLabelText('Facility')).toBeVisible()
 })
 it('does not load billing for non-admin staff', () => {
  useAuth.mockReturnValue({ role: 'pharmacist' })
  render(<PlatformBilling />)
  expect(supabase.rpc).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: 'Subscription billing' })).not.toBeInTheDocument()
 })
})

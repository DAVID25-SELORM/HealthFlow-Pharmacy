import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, it, expect, vi } from 'vitest'
import CccIntegrationSettings from './CccIntegrationSettings'
import { cccIntegration } from '../services/cccIntegrationService'
vi.mock('../services/cccIntegrationService', () => ({ cccIntegration: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('retains enabled NeHFAMS when unchanged settings are saved', async () => {
 const data=productionData(); data.policy.enabled=true
 cccIntegration.mockResolvedValue(data)
 render(<CccIntegrationSettings organizationId="unchanged" />)
 fireEvent.click(await screen.findByText('Save CCC settings'))
 expect(cccIntegration).toHaveBeenCalledTimes(1)
 expect(screen.getByText('Connection unchanged. CCC generation remains enabled.')).toBeInTheDocument()
})
it('blocks validation and activation of unsaved credentials', async () => {
 cccIntegration.mockResolvedValue(productionData())
 render(<CccIntegrationSettings organizationId="dirty" />)
 await screen.findByText('Validate saved connection')
 fireEvent.change(screen.getByLabelText('NeHFAMS API secret'),{target:{value:'replacement'}})
 expect(screen.getByText('Validate saved connection')).toBeDisabled()
 expect(screen.getByText('Enable routine production attendance')).toBeDisabled()
 expect(cccIntegration).toHaveBeenCalledTimes(1)
})
it('restores NeHFAMS identity when switching from a legacy policy and keeps the selection after validation', async () => {
 const data=productionData({policy:{provider:'existing',enabled:true,environment:'production',expectedHpn:'old',expectedFacilityName:'Legacy name'}})
 cccIntegration.mockResolvedValue(data)
 render(<CccIntegrationSettings organizationId="switch" />)
 fireEvent.click(await screen.findByRole('radio',{name:/NHIA NeHFAMS/}))
 expect(screen.getByLabelText('Expected facility HPN')).toHaveValue('123')
 expect(screen.getByLabelText('Expected facility name')).toHaveValue('Test Facility')
 fireEvent.click(screen.getByText('Validate saved connection'))
 await waitFor(()=>expect(cccIntegration).toHaveBeenCalledWith('validate_nehfams_connection',{organizationId:'switch',environment:'production'}))
 await waitFor(()=>expect(screen.getByText('Validate saved connection')).toBeEnabled())
 expect(screen.getByRole('radio',{name:/NHIA NeHFAMS/})).toBeChecked()
})
it('keeps legacy selected and saves NeHFAMS only as disabled with separate secrets', async () => {
 const policy={provider:'existing',enabled:true,expectedHpn:'295',expectedFacilityName:'Test',hasToken:false}
 cccIntegration.mockResolvedValue({policy,nehfamsConfigured:false,requests:[],history:[]})
 render(<CccIntegrationSettings organizationId="org-a" />)
 await screen.findByText('Save CCC settings')
 expect(screen.getByRole('radio',{name:/Existing NHIA API/})).toBeChecked()
 fireEvent.click(screen.getByRole('radio',{name:/NHIA NeHFAMS/}))
 expect(screen.queryByRole('checkbox',{name:/Enable CCC/})).not.toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('NeHFAMS API key'),{target:{value:'synthetic-key'}})
 fireEvent.change(screen.getByLabelText('NeHFAMS API secret'),{target:{value:'synthetic-secret'}})
 cccIntegration.mockResolvedValue({policy:{...policy,provider:'nehfams',enabled:false},nehfamsConfigured:true,requests:[],history:[]})
 fireEvent.click(screen.getByText('Save CCC settings'))
 await waitFor(()=>expect(cccIntegration).toHaveBeenCalledWith('save_ccc_policy',expect.objectContaining({organizationId:'org-a',provider:'nehfams',enabled:false,nehfamsApiKey:'synthetic-key',nehfamsApiSecret:'synthetic-secret',bearerToken:''})))
 await waitFor(()=>expect(screen.getByLabelText('NeHFAMS API secret')).toHaveValue(''))
})

const productionData = (overrides = {}) => ({
 policy: { provider: 'nehfams', environment: 'production', enabled: false, nehfams: { expectedHpn: '123', expectedFacilityName: 'Test Facility' } },
 nehfamsConnections: [{ environment: 'production', validated: true, authMode: '1FA', otacRequired: false, expectedHpn: '123', expectedFacilityName: 'Test Facility' }],
 nehfamsProductionEnabled: true, nehfamsProductionApproval: { limit: 1, used: 0, remaining: 1 }, requests: [], history: [], ...overrides,
})

it('enables approved production attendance only through the activation action', async () => {
 cccIntegration.mockResolvedValue(productionData())
 render(<CccIntegrationSettings organizationId="org-p" />)
 const button = await screen.findByText('Enable routine production attendance')
 expect(screen.getByText('Approved production attendances remaining: 1 of 1.')).toBeInTheDocument()
 expect(button).toBeEnabled()
 fireEvent.click(button)
 await waitFor(() => expect(cccIntegration).toHaveBeenCalledWith('activate_nehfams_production', { organizationId: 'org-p', environment: 'production' }))
})

it.each([
 ['the production switch is off on this deployment', { nehfamsProductionEnabled: false }],
 ['the connection has not been validated', { nehfamsConnections: [{ environment: 'production', validated: false, expectedFacilityName: 'Test Facility' }] }],
])('keeps the production button disabled when %s', async (_label, overrides) => {
 cccIntegration.mockResolvedValue(productionData(overrides))
 render(<CccIntegrationSettings organizationId="org-q" />)
 expect(await screen.findByText('Enable routine production attendance')).toBeDisabled()
})

it('says production is not approved when there is no approval, and never shows the button for the test environment', async () => {
 cccIntegration.mockResolvedValue(productionData({ nehfamsProductionApproval: null }))
 render(<CccIntegrationSettings organizationId="org-r" />)
 expect(await screen.findByText('Production NeHFAMS is not approved for this facility.')).toBeInTheDocument()
 cleanup()
 cccIntegration.mockResolvedValue(productionData({ policy: { provider: 'nehfams', environment: 'test', enabled: false, nehfams: { expectedHpn: '123', expectedFacilityName: 'Test Facility' } }, nehfamsConnections: [{ environment: 'test', validated: true, authMode: '1FA', otacRequired: false, expectedHpn: '123', expectedFacilityName: 'Test Facility' }] }))
 render(<CccIntegrationSettings organizationId="org-s" />)
 await screen.findByText('Enable authorized test attendance')
 expect(screen.queryByText('Enable routine production attendance')).not.toBeInTheDocument()
})

it('offers saved facility credentials without requiring plaintext entry', async () => {
 cccIntegration.mockResolvedValue({policy:{provider:'existing',enabled:true,expectedHpn:'123',expectedFacilityName:'Test Facility'},nehfamsConfigured:false,nehfamsReusableCredentials:true,requests:[],history:[]})
 render(<CccIntegrationSettings organizationId="org-b" />)
 await screen.findByText('Save CCC settings')
 fireEvent.click(screen.getByRole('radio',{name:/NHIA NeHFAMS/}))
 expect(screen.getByLabelText('NeHFAMS API key')).not.toBeRequired()
 expect(screen.getByLabelText('NeHFAMS API secret')).not.toBeRequired()
 expect(screen.getByLabelText('NeHFAMS API secret')).toHaveValue('')
 fireEvent.click(screen.getByText('Save CCC settings'))
 await waitFor(()=>expect(cccIntegration).toHaveBeenCalledWith('save_ccc_policy',expect.objectContaining({organizationId:'org-b',provider:'nehfams',enabled:false,nehfamsApiKey:'',nehfamsApiSecret:''})))
})

it.each([null,{limit:3,used:3,remaining:0}])('allows explicit routine activation without a remaining trial allowance',async approval=>{
 cccIntegration.mockResolvedValue(productionData({nehfamsProductionApproval:approval}))
 render(<CccIntegrationSettings organizationId="org-routine" />)
 const button=await screen.findByText('Enable routine production attendance')
 expect(button).toBeEnabled()
 fireEvent.click(button)
 await waitFor(()=>expect(cccIntegration).toHaveBeenCalledWith('activate_nehfams_production',{organizationId:'org-routine',environment:'production'}))
})

it('shows failed validation beside its controls and releases the busy state', async () => {
 cccIntegration.mockResolvedValueOnce(productionData({nehfamsConnections:[{environment:'production',validated:false,expectedHpn:'123',expectedFacilityName:'Test Facility'}]}))
 let rejectValidation
 cccIntegration.mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectValidation=reject}))
 render(<CccIntegrationSettings organizationId="org-validation" />)
 fireEvent.click(await screen.findByText('Validate saved connection'))
 expect(await screen.findByText('Validating connection...')).toBeDisabled()
 expect(screen.getByText('Save CCC settings')).toBeDisabled()
 rejectValidation(new Error('NHIA rejected the saved API credentials.'))
 const alert=await screen.findByRole('alert')
 expect(alert).toHaveTextContent('NHIA rejected the saved API credentials.')
 expect(alert.closest('.ccc-credentials')).not.toBeNull()
 expect(screen.getByText('Validate saved connection')).toBeEnabled()
 expect(screen.getByText('Enable routine production attendance')).toBeDisabled()
 expect(screen.getByText('Save CCC settings')).toBeEnabled()
})

import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { afterEach, it, expect, vi } from 'vitest'
import CccIntegrationSettings from './CccIntegrationSettings'
import { cccIntegration } from '../services/cccIntegrationService'
vi.mock('../services/cccIntegrationService', () => ({ cccIntegration: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('keeps legacy selected and saves NeHFAMS only as disabled with separate secrets', async () => {
 const policy={provider:'existing',enabled:true,expectedHpn:'295',expectedFacilityName:'Test',hasToken:false}
 cccIntegration.mockResolvedValue({policy,nehfamsConfigured:false,requests:[],history:[]})
 render(<CccIntegrationSettings organizationId="org-a" />)
 await screen.findByText('Save CCC settings')
 expect(screen.getByRole('radio',{name:/Existing NHIA API/})).toBeChecked()
 fireEvent.click(screen.getByRole('radio',{name:/NHIA NeHFAMS/}))
 expect(screen.getByRole('checkbox',{name:/Enable CCC/})).toBeDisabled()
 expect(screen.getByRole('checkbox',{name:/Enable CCC/})).not.toBeChecked()
 fireEvent.change(screen.getByLabelText('NeHFAMS API key'),{target:{value:'synthetic-key'}})
 fireEvent.change(screen.getByLabelText('NeHFAMS API secret'),{target:{value:'synthetic-secret'}})
 cccIntegration.mockResolvedValue({policy:{...policy,provider:'nehfams',enabled:false},nehfamsConfigured:true,requests:[],history:[]})
 fireEvent.click(screen.getByText('Save CCC settings'))
 await waitFor(()=>expect(cccIntegration).toHaveBeenCalledWith('save_ccc_policy',expect.objectContaining({organizationId:'org-a',provider:'nehfams',enabled:false,nehfamsApiKey:'synthetic-key',nehfamsApiSecret:'synthetic-secret',bearerToken:''})))
 await waitFor(()=>expect(screen.getByLabelText('NeHFAMS API secret')).toHaveValue(''))
})

const productionData = (overrides = {}) => ({
 policy: { provider: 'nehfams', environment: 'production', enabled: false, nehfams: { expectedHpn: '123', expectedFacilityName: 'Test Facility' } },
 nehfamsConnections: [{ environment: 'production', validated: true, authMode: '1FA', otacRequired: false, expectedFacilityName: 'Test Facility' }],
 nehfamsProductionEnabled: true, nehfamsProductionApproval: { limit: 1, used: 0, remaining: 1 }, requests: [], history: [], ...overrides,
})

it('enables approved production attendance only through the activation action', async () => {
 cccIntegration.mockResolvedValue(productionData())
 render(<CccIntegrationSettings organizationId="org-p" />)
 const button = await screen.findByText('Enable approved production attendance')
 expect(screen.getByText('Approved production attendances remaining: 1 of 1.')).toBeInTheDocument()
 expect(button).toBeEnabled()
 fireEvent.click(button)
 await waitFor(() => expect(cccIntegration).toHaveBeenCalledWith('activate_nehfams_production', { organizationId: 'org-p', environment: 'production' }))
})

it.each([
 ['the production switch is off on this deployment', { nehfamsProductionEnabled: false }],
 ['the facility has no approval', { nehfamsProductionApproval: null }],
 ['the approved allowance is used up', { nehfamsProductionApproval: { limit: 1, used: 1, remaining: 0 } }],
 ['the connection has not been validated', { nehfamsConnections: [{ environment: 'production', validated: false, expectedFacilityName: 'Test Facility' }] }],
])('keeps the production button disabled when %s', async (_label, overrides) => {
 cccIntegration.mockResolvedValue(productionData(overrides))
 render(<CccIntegrationSettings organizationId="org-q" />)
 expect(await screen.findByText('Enable approved production attendance')).toBeDisabled()
})

it('says production is not approved when there is no approval, and never shows the button for the test environment', async () => {
 cccIntegration.mockResolvedValue(productionData({ nehfamsProductionApproval: null }))
 render(<CccIntegrationSettings organizationId="org-r" />)
 expect(await screen.findByText('Production NeHFAMS is not approved for this facility.')).toBeInTheDocument()
 cleanup()
 cccIntegration.mockResolvedValue(productionData({ policy: { provider: 'nehfams', environment: 'test', enabled: false, nehfams: { expectedHpn: '123', expectedFacilityName: 'Test Facility' } }, nehfamsConnections: [{ environment: 'test', validated: true, authMode: '1FA', otacRequired: false, expectedFacilityName: 'Test Facility' }] }))
 render(<CccIntegrationSettings organizationId="org-s" />)
 await screen.findByText('Enable authorized test attendance')
 expect(screen.queryByText('Enable approved production attendance')).not.toBeInTheDocument()
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

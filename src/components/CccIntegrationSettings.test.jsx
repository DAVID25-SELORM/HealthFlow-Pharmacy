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

it('offers saved facility credentials without requiring plaintext entry', async () => {
 cccIntegration.mockResolvedValue({policy:{provider:'existing',enabled:true},nehfamsConfigured:false,nehfamsReusableCredentials:true,requests:[],history:[]})
 render(<CccIntegrationSettings organizationId="org-b" />)
 await screen.findByText('Save CCC settings')
 fireEvent.click(screen.getByRole('radio',{name:/NHIA NeHFAMS/}))
 expect(screen.getByLabelText('NeHFAMS API key')).not.toBeRequired()
 expect(screen.getByLabelText('NeHFAMS API secret')).not.toBeRequired()
 expect(screen.getByLabelText('NeHFAMS API secret')).toHaveValue('')
 fireEvent.click(screen.getByText('Save CCC settings'))
 await waitFor(()=>expect(cccIntegration).toHaveBeenCalledWith('save_ccc_policy',expect.objectContaining({organizationId:'org-b',provider:'nehfams',enabled:false,nehfamsApiKey:'',nehfamsApiSecret:''})))
})

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { it, expect, vi } from 'vitest'
import CccIntegrationSettings from './CccIntegrationSettings'
import { cccIntegration } from '../services/cccIntegrationService'
vi.mock('../services/cccIntegrationService', () => ({ cccIntegration: vi.fn() }))
it('stages NeHFAMS disabled without exposing credential fields', async () => {
 const policy={provider:'existing',enabled:true,expectedHpn:'123',expectedFacilityName:'Test',hasToken:true,status:'existing_configuration'}
 cccIntegration.mockResolvedValue({policy,requests:[],history:[]})
 render(<CccIntegrationSettings organizationId="org-one" />)
 const choice=await screen.findByRole('radio',{name:/NeHFAMS/})
 fireEvent.click(choice)
 expect(screen.getByRole('checkbox',{name:/Enable CCC generation/})).toBeDisabled()
 expect(screen.getByRole('checkbox',{name:/Enable CCC generation/})).not.toBeChecked()
 expect(screen.queryByLabelText(/New Bearer token/)).not.toBeInTheDocument()
 fireEvent.click(screen.getByRole('button',{name:'Save CCC settings'}))
 await waitFor(()=>expect(cccIntegration).toHaveBeenCalledWith('save_ccc_policy',expect.objectContaining({organizationId:'org-one',provider:'nehfams',enabled:false,bearerToken:''})))
})

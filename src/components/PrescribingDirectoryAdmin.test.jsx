import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import PrescribingDirectoryAdmin from './PrescribingDirectoryAdmin'
import { searchPrescribingDirectory, savePrescribingDirectoryEntry } from '../services/prescribingDirectoryService'
vi.mock('../services/prescribingDirectoryService',()=>({searchPrescribingDirectory:vi.fn(),savePrescribingDirectoryEntry:vi.fn()}))
beforeEach(()=>{vi.clearAllMocks();searchPrescribingDirectory.mockResolvedValue([]);savePrescribingDirectoryEntry.mockResolvedValue({id:'new'})})
it('does not load the directory until expanded; adds reference names with unknown eligibility',async()=>{
 render(<PrescribingDirectoryAdmin />)
 expect(searchPrescribingDirectory).not.toHaveBeenCalled()
 fireEvent.click(screen.getByText('Manage directory'))
 fireEvent.click(screen.getByText('Add directory entry'))
 fireEvent.change(screen.getByLabelText('Facility name'),{target:{value:'Clinic A'}})
 fireEvent.change(screen.getByLabelText('Aliases (comma separated)'),{target:{value:'A clinic, A'}})
 fireEvent.click(screen.getByText('Save directory entry'))
 await waitFor(()=>expect(savePrescribingDirectoryEntry).toHaveBeenCalledWith(expect.objectContaining({facility_name:'Clinic A',aliases:['A clinic',' A'],nhis_enabled:null,status:'active'})))
})
it('edits and deactivates an entry using its stable ID',async()=>{
 searchPrescribingDirectory.mockResolvedValue([{id:'ridge',facility_name:'Greater Accra Regional Hospital',aliases:['Ridge'],nhis_enabled:null,status:'active'}])
 render(<PrescribingDirectoryAdmin />)
 fireEvent.click(screen.getByText('Manage directory'))
 fireEvent.click(await screen.findByText('Edit Greater Accra Regional Hospital'))
 fireEvent.change(screen.getByLabelText('Status'),{target:{value:'inactive'}})
 fireEvent.click(screen.getByText('Save directory entry'))
 await waitFor(()=>expect(savePrescribingDirectoryEntry).toHaveBeenCalledWith(expect.objectContaining({id:'ridge',status:'inactive'})))
})

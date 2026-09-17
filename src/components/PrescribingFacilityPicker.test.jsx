import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import PrescribingFacilityPicker from './PrescribingFacilityPicker'
import { searchPrescribingDirectory } from '../services/prescribingDirectoryService'
vi.mock('../services/prescribingDirectoryService', () => ({ searchPrescribingDirectory: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
it.each([['Korle','Korle Bu Teaching Hospital',[]],['Ridge','Greater Accra Regional Hospital',['Ridge']],['UGMC','University of Ghana Medical Centre',['UGMC']]])('searches %s and selects by keyboard', async (term,name,aliases) => {
 const facility = { id:'stable-id',facility_name:name,aliases,is_shared:true }
 searchPrescribingDirectory.mockResolvedValue([facility])
 const select = vi.fn()
 render(<PrescribingFacilityPicker onSelect={select} onManualChange={vi.fn()} />)
 const input=screen.getByRole('combobox')
 fireEvent.change(input,{target:{value:term}})
 await screen.findByRole('option')
 expect(searchPrescribingDirectory).toHaveBeenLastCalledWith({search:term,nhisOnly:false})
 fireEvent.keyDown(input,{key:'Enter'})
 expect(select).toHaveBeenCalledWith(facility)
})
it('Other clears identity and edits manual source without selecting or writing directory', () => {
 const manual=vi.fn(),select=vi.fn()
 render(<PrescribingFacilityPicker onSelect={select} onManualChange={manual} />)
 fireEvent.click(screen.getByText('Other / Facility not listed'))
 fireEvent.change(screen.getByLabelText('Unlisted facility name'),{target:{value:'Small Clinic'}})
 expect(manual.mock.calls).toEqual([[''],['Small Clinic']])
 expect(select).not.toHaveBeenCalled()
 expect(searchPrescribingDirectory).not.toHaveBeenCalled()
})
it('shows saved snapshot without looking up an inactive/renamed facility', () => {
 render(<PrescribingFacilityPicker facilityId="old-id" value="Original Hospital" onSelect={vi.fn()} onManualChange={vi.fn()} />)
 expect(screen.getByText('Original Hospital (selected)')).toBeInTheDocument()
 expect(searchPrescribingDirectory).not.toHaveBeenCalled()
})
it('passes the optional NHIS filter and bounds visible results', async () => {
 searchPrescribingDirectory.mockResolvedValue(Array.from({length:50},(_,i)=>({id:String(i),facility_name:`Hospital ${i}`})))
 render(<PrescribingFacilityPicker nhis onSelect={vi.fn()} onManualChange={vi.fn()} />)
 fireEvent.focus(screen.getByRole('combobox'))
 fireEvent.click(screen.getByRole('checkbox'))
 await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(30))
 expect(searchPrescribingDirectory).toHaveBeenLastCalledWith({search:'',nhisOnly:true})
})

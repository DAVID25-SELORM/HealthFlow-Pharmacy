import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import ProtectedRoute from './ProtectedRoute'
import { recordWorkspaceLoadFailure } from '../../utils/workspaceLoadFailure'

const auth = vi.hoisted(() => ({loading:false,isAuthenticated:true,isConfigured:true,signOut:vi.fn()}))
vi.mock('../../context/AuthContext', () => ({useAuth:()=>auth}))
describe('protected route session loading', () => {
  it('does not redirect while storage restoration is pending', () => {
    Object.assign(auth,{loading:true,isAuthenticated:false,profileLoadError:''})
    render(<MemoryRouter><ProtectedRoute>Protected content</ProtectedRoute></MemoryRouter>)
    expect(screen.getByText('Loading session...')).toBeInTheDocument()
    expect(auth.signOut).not.toHaveBeenCalled()
  })
  it('shows a retry error without signing out or exposing protected content', () => {
    Object.assign(auth,{loading:false,isAuthenticated:true,profileLoadError:'Your staff profile could not be loaded.'})
    render(<MemoryRouter><ProtectedRoute>Protected content</ProtectedRoute></MemoryRouter>)
    expect(screen.getByRole('alert')).toHaveTextContent('Your staff profile could not be loaded.')
    expect(screen.getByRole('button',{name:'Retry loading'})).toBeInTheDocument()
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument()
    expect(auth.signOut).not.toHaveBeenCalled()
  })
  it('says why the workspace did not load and that HealthFlow is retrying on its own', () => {
    window.localStorage.removeItem('healthflow_workspace_load_failures')
    recordWorkspaceLoadFailure({ message: 'Profile request timed out' })
    Object.assign(auth,{loading:false,isAuthenticated:true,profileLoadError:'Your staff profile could not be loaded.'})
    render(<MemoryRouter><ProtectedRoute>Protected content</ProtectedRoute></MemoryRouter>)
    expect(screen.getByRole('alert')).toHaveTextContent('The server took too long to answer.')
    expect(screen.getByRole('alert')).toHaveTextContent('trying again automatically')
    expect(screen.getByRole('button',{name:'Retry loading'})).toBeInTheDocument()
    window.localStorage.removeItem('healthflow_workspace_load_failures')
  })
})

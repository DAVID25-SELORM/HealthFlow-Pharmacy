import { createRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import NhisCorrectionReason from './NhisCorrectionReason'

const lowered = [
  { key: 'AAA', description: 'Medicine AAA', from: 30, to: 20, removed: false },
  { key: 'BBB', description: 'Medicine BBB', from: 5, to: 0, removed: true },
]

const Harness = (props) => {
  const [value, setValue] = useState('')
  return <NhisCorrectionReason value={value} onChange={setValue} {...props} />
}

describe('NhisCorrectionReason', () => {
  it('stays an optional box for ordinary corrections', () => {
    render(<Harness />)

    expect(screen.getByRole('heading').textContent).toBe('Reason for correction (optional)')
    expect(screen.queryByRole('group', { name: 'Common reasons' })).toBeNull()
    expect(screen.getByRole('textbox').getAttribute('aria-required')).toBe('false')
  })

  it('says what was lowered and fills the reason with one tap', () => {
    render(<Harness reductions={lowered} />)

    expect(screen.getByRole('heading').textContent).toBe('Why was the quantity lowered? (needed to save)')
    expect(screen.getByText('Medicine AAA').closest('li').textContent).toBe('Medicine AAA: 30 → 20')
    expect(screen.getByText('Medicine BBB').closest('li').textContent).toBe('Medicine BBB: removed (was 5)')

    fireEvent.click(screen.getByRole('button', { name: 'Typed the wrong quantity' }))

    expect(screen.getByRole('textbox').value).toBe('Typed the wrong quantity')
    expect(screen.getByRole('button', { name: 'Typed the wrong quantity' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('points out a missing reason only after a save asked for it', () => {
    const { rerender } = render(<NhisCorrectionReason value="" onChange={() => {}} reductions={lowered} />)
    expect(screen.queryByText('Tap a reason or type one, then save again.')).toBeNull()

    rerender(<NhisCorrectionReason value="" onChange={() => {}} reductions={lowered} showMissing />)
    expect(screen.getByText('Tap a reason or type one, then save again.')).toBeTruthy()
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true')

    rerender(<NhisCorrectionReason value="Typed the wrong quantity" onChange={() => {}} reductions={lowered} showMissing />)
    expect(screen.queryByText('Tap a reason or type one, then save again.')).toBeNull()
  })

  it('asks when the database asks, even if the screen saw no change', () => {
    render(<Harness requiredBySave showMissing />)

    expect(screen.getByRole('heading').textContent).toContain('needed to save')
    expect(screen.getByRole('button', { name: 'Medicine was not given' })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('warns someone who is not an Admin', () => {
    const { rerender } = render(<Harness reductions={lowered} isAdmin={false} />)
    expect(screen.getByText(/Only an Admin can save that change\./)).toBeTruthy()

    rerender(<Harness reductions={lowered} isAdmin />)
    expect(screen.queryByText(/Only an Admin/)).toBeNull()
  })

  it('can bring itself into view and take the cursor', () => {
    const ref = createRef()
    const scrollIntoView = vi.fn()
    const { container } = render(<NhisCorrectionReason ref={ref} value="" onChange={() => {}} />)
    container.querySelector('section').scrollIntoView = scrollIntoView

    act(() => ref.current.show())

    expect(scrollIntoView).toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })
})

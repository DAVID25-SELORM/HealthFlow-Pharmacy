import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationProvider, getToastDuration, useNotification } from './NotificationContext'

const NO_MEMBERSHIP_ERROR = 'NHIA reports that this client has no active NHIS membership. Renew the membership and try again.'

const CallerHarness = ({ calls }) => {
  const { notify } = useNotification()

  return (
    <div>
      {calls.map(([label, message, type, duration]) => (
        <button key={label} type="button" onClick={() => notify(message, type, duration)}>
          {label}
        </button>
      ))}
    </div>
  )
}

const renderCalls = (calls) =>
  render(
    <NotificationProvider>
      <CallerHarness calls={calls} />
    </NotificationProvider>
  )

const NotificationHarness = () => {
  const { notify } = useNotification()

  return (
    <div>
      <button type="button" onClick={() => notify('Read this warning fully.', 'warning', 500)}>
        Show warning
      </button>
      <button type="button" onClick={() => notify('Quick info.', 'info', 500)}>
        Show info
      </button>
      <button type="button" onClick={() => notify('Review this blocking alert.', 'error', 0)}>
        Show blocking alert
      </button>
    </div>
  )
}

const renderNotifications = () =>
  render(
    <NotificationProvider>
      <NotificationHarness />
    </NotificationProvider>
  )

afterEach(() => {
  vi.useRealTimers()
})

describe('NotificationProvider', () => {
  it('keeps warning notifications visible until the user dismisses them', () => {
    vi.useFakeTimers()
    renderNotifications()

    fireEvent.click(screen.getByRole('button', { name: 'Show warning' }))
    expect(screen.getByText('Read this warning fully.')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByText('Read this warning fully.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Read this warning fully.')).not.toBeInTheDocument()
  })

  it('still auto-dismisses non-warning notifications', () => {
    vi.useFakeTimers()
    renderNotifications()

    fireEvent.click(screen.getByRole('button', { name: 'Show info' }))
    expect(screen.getByText('Quick info.')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.queryByText('Quick info.')).not.toBeInTheDocument()
  })

  it('keeps an explicitly persistent error visible until the user dismisses it', () => {
    vi.useFakeTimers()
    renderNotifications()

    fireEvent.click(screen.getByRole('button', { name: 'Show blocking alert' }))
    expect(screen.getByText('Review this blocking alert.')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(screen.getByText('Review this blocking alert.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Review this blocking alert.')).not.toBeInTheDocument()
  })

  it('keeps an error visible until dismissed even when the caller gives no duration', () => {
    vi.useFakeTimers()
    renderCalls([['Raise error', NO_MEMBERSHIP_ERROR, 'error']])

    fireEvent.click(screen.getByRole('button', { name: 'Raise error' }))
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(screen.getByText(NO_MEMBERSHIP_ERROR)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText(NO_MEMBERSHIP_ERROR)).not.toBeInTheDocument()
  })

  it('keeps an error visible even when the caller asks for a short duration', () => {
    vi.useFakeTimers()
    renderCalls([['Raise error', 'Save failed.', 'error', 2000]])

    fireEvent.click(screen.getByRole('button', { name: 'Raise error' }))
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByText('Save failed.')).toBeInTheDocument()
  })

  it('gives longer success and info messages longer to be read', () => {
    vi.useFakeTimers()
    const longMessage = `Saved. ${'x'.repeat(193)}`
    renderCalls([
      ['Short', 'Saved.', 'success'],
      ['Long', longMessage, 'info'],
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Short' }))
    fireEvent.click(screen.getByRole('button', { name: 'Long' }))

    act(() => {
      vi.advanceTimersByTime(3_800)
    })
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument()
    expect(screen.getByText(longMessage)).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(7_000)
    })
    expect(screen.getByText(longMessage)).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(screen.queryByText(longMessage)).not.toBeInTheDocument()
  })

  it('still honours an explicit duration for success and info toasts', () => {
    vi.useFakeTimers()
    renderCalls([['Quick', 'Done.', 'success', 700]])

    fireEvent.click(screen.getByRole('button', { name: 'Quick' }))
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(screen.queryByText('Done.')).not.toBeInTheDocument()
  })

  it('pauses a timed toast while the pointer is on it and resumes afterwards', () => {
    vi.useFakeTimers()
    renderCalls([['Info', 'Please read this carefully.', 'info']])

    fireEvent.click(screen.getByRole('button', { name: 'Info' }))
    const toast = screen.getByText('Please read this carefully.').closest('.toast-item')

    fireEvent.mouseEnter(toast)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByText('Please read this carefully.')).toBeInTheDocument()

    fireEvent.mouseLeave(toast)
    act(() => {
      vi.advanceTimersByTime(12_000)
    })
    expect(screen.queryByText('Please read this carefully.')).not.toBeInTheDocument()
  })

  it('does not stack an identical message that is already showing', () => {
    vi.useFakeTimers()
    renderCalls([['Raise error', NO_MEMBERSHIP_ERROR, 'error']])

    fireEvent.click(screen.getByRole('button', { name: 'Raise error' }))
    fireEvent.click(screen.getByRole('button', { name: 'Raise error' }))
    fireEvent.click(screen.getByRole('button', { name: 'Raise error' }))

    expect(screen.getAllByText(NO_MEMBERSHIP_ERROR)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Dismiss all notifications' })).not.toBeInTheDocument()
  })

  it('offers Dismiss all when several notifications are showing', () => {
    renderCalls([
      ['Error one', 'First problem.', 'error'],
      ['Error two', 'Second problem.', 'error'],
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Error one' }))
    expect(screen.queryByRole('button', { name: 'Dismiss all notifications' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Error two' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss all notifications' }))

    expect(screen.queryByText('First problem.')).not.toBeInTheDocument()
    expect(screen.queryByText('Second problem.')).not.toBeInTheDocument()
  })

  it('dismisses the newest notification with Escape', () => {
    renderCalls([
      ['Error one', 'First problem.', 'error'],
      ['Error two', 'Second problem.', 'error'],
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Error one' }))
    fireEvent.click(screen.getByRole('button', { name: 'Error two' }))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.getByText('First problem.')).toBeInTheDocument()
    expect(screen.queryByText('Second problem.')).not.toBeInTheDocument()
  })

  it('caps the number of notifications on screen, dropping the oldest', () => {
    const calls = Array.from({ length: 8 }, (_, index) => [`Raise ${index + 1}`, `Problem ${index + 1}.`, 'error'])
    renderCalls(calls)

    for (const [label] of calls) {
      fireEvent.click(screen.getByRole('button', { name: label }))
    }

    expect(screen.queryByText('Problem 1.')).not.toBeInTheDocument()
    expect(screen.queryByText('Problem 2.')).not.toBeInTheDocument()
    expect(screen.getByText('Problem 3.')).toBeInTheDocument()
    expect(screen.getByText('Problem 8.')).toBeInTheDocument()
  })
})

describe('getToastDuration', () => {
  it('never auto-dismisses errors or warnings', () => {
    expect(getToastDuration('error', undefined, 'x')).toBe(0)
    expect(getToastDuration('error', 5000, 'x')).toBe(0)
    expect(getToastDuration('warning', 500, 'x')).toBe(0)
  })

  it('scales info and success with message length, within a cap', () => {
    expect(getToastDuration('success', undefined, '')).toBe(3500)
    expect(getToastDuration('info', undefined, 'x'.repeat(100))).toBe(7500)
    expect(getToastDuration('info', undefined, 'x'.repeat(5000))).toBe(12000)
  })

  it('uses an explicit duration, and 0 means stay until dismissed', () => {
    expect(getToastDuration('success', 6000, 'x')).toBe(6000)
    expect(getToastDuration('info', 0, 'x')).toBe(0)
  })
})

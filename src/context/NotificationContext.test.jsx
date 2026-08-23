import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationProvider, useNotification } from './NotificationContext'

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
})

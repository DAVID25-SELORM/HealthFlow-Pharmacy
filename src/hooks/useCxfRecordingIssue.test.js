import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useCxfRecordingIssue } from './useCxfRecordingIssue'

it('restores a repair after remount, isolates accounts and clears completed repairs', () => {
  sessionStorage.clear()
  const first = renderHook(() => useCxfRecordingIssue('user-a', 'facility-a'))
  const manifest = { artifactSha256: 'abc', pendingChunkIndexes: [0] }
  act(() => first.result.current[1](manifest))
  first.unmount()
  const restored = renderHook(({ user }) => useCxfRecordingIssue(user, 'facility-a'), { initialProps: { user: 'user-a' } })
  expect(restored.result.current[0]).toEqual(manifest)
  restored.rerender({ user: 'user-b' })
  expect(restored.result.current[0]).toBeNull()
  restored.rerender({ user: 'user-a' })
  act(() => restored.result.current[1](null))
  restored.unmount()
  const cleared = renderHook(() => useCxfRecordingIssue('user-a', 'facility-a'))
  expect(cleared.result.current[0]).toBeNull()
  cleared.unmount()
})

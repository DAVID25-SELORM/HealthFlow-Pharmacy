import { useEffect, useState } from 'react'

const resolveInitialValue = (initialValue) =>
  typeof initialValue === 'function' ? initialValue() : initialValue

const readStoredValue = (key, initialValue, validate) => {
  const fallbackValue = resolveInitialValue(initialValue)

  if (typeof window === 'undefined' || !key) {
    return fallbackValue
  }

  try {
    const rawValue = window.sessionStorage.getItem(key)
    if (rawValue === null) {
      return fallbackValue
    }

    const parsedValue = JSON.parse(rawValue)
    if (validate && !validate(parsedValue)) {
      window.sessionStorage.removeItem(key)
      return fallbackValue
    }

    return parsedValue
  } catch {
    return fallbackValue
  }
}

export const useSessionStorageState = (key, initialValue, options = {}) => {
  const { validate } = options
  const [value, setValue] = useState(() => readStoredValue(key, initialValue, validate))

  useEffect(() => {
    if (typeof window === 'undefined' || !key) {
      return
    }

    try {
      window.sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Ignore storage quota or browser privacy mode failures.
    }
  }, [key, value])

  return [value, setValue]
}

export default useSessionStorageState

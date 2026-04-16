export const HEALTHFLOW_DATA_CHANGED_EVENT = 'healthflow:data-changed'

export const dispatchHealthflowDataChanged = () => {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new Event(HEALTHFLOW_DATA_CHANGED_EVENT))
}

export const subscribeToHealthflowDataChanged = (handler) => {
  if (typeof window === 'undefined') {
    return () => {}
  }

  window.addEventListener(HEALTHFLOW_DATA_CHANGED_EVENT, handler)

  return () => {
    window.removeEventListener(HEALTHFLOW_DATA_CHANGED_EVENT, handler)
  }
}

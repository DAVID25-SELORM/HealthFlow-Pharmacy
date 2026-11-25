import { useEffect, useState } from 'react'
import { subscribeBranchUpdateNotice } from '../services/branchUpdateNotice'

// null on the online website, and on an offline server until it has answered.
export const useBranchUpdateNotice = () => {
  const [notice, setNotice] = useState(null)
  useEffect(() => subscribeBranchUpdateNotice(setNotice), [])
  return notice
}

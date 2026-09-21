// Optional browser capabilities and the host-injected offline configuration.
interface HealthFlowNetworkInformation {
  effectiveType?: string
  downlink?: number
  rtt?: number
  saveData?: boolean
}

interface Navigator {
  connection?: HealthFlowNetworkInformation
  mozConnection?: HealthFlowNetworkInformation
  webkitConnection?: HealthFlowNetworkInformation
  userAgentData?: { platform?: string }
}

interface Window {
  __HEALTHFLOW_BRANCH_SERVER__?: {
    enabled?: boolean
    token?: string
    url?: string
    organizationId?: string
    branchId?: string
  }
}

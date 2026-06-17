import { invokeSupabaseFunction, invokeSupabaseFunctionResponse } from '../lib/supabase'

const BACKUP_ADMIN_FUNCTION = 'backup-admin'

const invokeBackupAdmin = async (payload) => {
  const { data, error } = await invokeSupabaseFunction(BACKUP_ADMIN_FUNCTION, {
    body: payload,
  })

  if (error) {
    throw error
  }

  if (data?.error) {
    throw new Error(data.error)
  }

  return data
}

export const listOnlineBackups = async () => {
  const response = await invokeBackupAdmin({ action: 'list_online_backups' })
  return Array.isArray(response.backups) ? response.backups : []
}

export const createOnlineBackup = async () => {
  const response = await invokeBackupAdmin({ action: 'create_online_backup' })
  return response.backup || null
}

export const downloadOnlineBackup = async (backup) => {
  const path = String(backup?.path || '').trim()
  if (!path) {
    throw new Error('Online backup path is missing.')
  }

  const response = await invokeSupabaseFunctionResponse(BACKUP_ADMIN_FUNCTION, {
    body: {
      action: 'download_online_backup',
      path,
    },
  })

  const fileName = getFileNameFromContentDisposition(response.headers.get('Content-Disposition')) ||
    backup.fileName ||
    'healthflow-online-backup.json'
  const blob = await response.blob()
  if (!blob.size) {
    throw new Error('Online backup download was empty. Please create a fresh backup and try again.')
  }

  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.setAttribute('download', fileName)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(objectUrl)
}

const getFileNameFromContentDisposition = (value) => {
  const header = String(value || '')
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }

  const match = header.match(/filename="?([^";]+)"?/i)
  return match?.[1] || ''
}

export const createOnlineBackupDownloadUrl = async (backup) => {
  const path = String(backup?.path || '').trim()
  if (!path) {
    throw new Error('Online backup path is missing.')
  }

  const response = await invokeBackupAdmin({
    action: 'create_online_backup_download_url',
    path,
  })

  if (!response.signedUrl) {
    throw new Error('Online backup download URL was not returned.')
  }

  return response
}

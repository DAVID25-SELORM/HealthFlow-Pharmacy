import { invokeSupabaseFunction } from '../lib/supabase'

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

  const response = await invokeBackupAdmin({
    action: 'create_online_backup_download_url',
    path,
  })

  if (!response.signedUrl) {
    throw new Error('Online backup download URL was not returned.')
  }

  const fileName = response.fileName || backup.fileName || 'healthflow-online-backup.json'
  const fileResponse = await fetch(response.signedUrl)
  if (!fileResponse.ok) {
    throw new Error('Unable to download online backup. Please try again to generate a fresh link.')
  }

  const blob = await fileResponse.blob()
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

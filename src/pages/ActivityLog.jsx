import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import './ActivityLog.css'

export default function ActivityLog() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    async function fetchLogs() {
      setLoading(true)
      setError('')
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) setError('Failed to load activity logs')
      setLogs(data || [])
      setLoading(false)
    }
    fetchLogs()
  }, [])

  if (loading) return <div className="activity-log">Loading activity logs...</div>
  if (error) return <div className="activity-log error">{error}</div>

  return (
    <div className="activity-log">
      <h2>Activity Log</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>User</th>
            <th>Action</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td>{new Date(log.created_at).toLocaleString()}</td>
              <td>{log.user_id || 'Unknown'}</td>
              <td>{log.event_type || log.action}</td>
              <td>{log.details ? JSON.stringify(log.details) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

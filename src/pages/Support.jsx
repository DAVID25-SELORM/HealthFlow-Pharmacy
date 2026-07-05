import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  BookOpen,
  CheckCircle2,
  FileText,
  LifeBuoy,
  Mail,
  MessageCircle,
  MonitorUp,
  Phone,
  Plus,
  Search,
  Send,
  Sparkles,
  Upload,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTenant } from '../context/TenantContext'
import { useNotification } from '../context/NotificationContext'
import { formatAppDateTime, formatAppDateKey } from '../utils/date'
import './Support.css'

const categories = [
  'NHIA Claims',
  'Patient Records',
  'Pharmacy',
  'Inventory',
  'Billing',
  'Login Issues',
  'Reports',
  'Offline Sync',
  'Local Server',
  'Feature Request',
  'Bug Report',
  'Other',
]

const priorities = ['Low', 'Medium', 'High', 'Critical']
const ticketStatuses = ['Open', 'In Progress', 'Waiting for User', 'Resolved', 'Closed']

const knowledgeBase = [
  {
    title: 'How to generate NHIA claims',
    category: 'NHIA Claims',
    summary: 'Confirm patient insurance details, add diagnoses and dispensed medicines, then validate the claim before submission.',
  },
  {
    title: 'How to create a patient',
    category: 'Patient Records',
    summary: 'Use Patients to register demographics, contact information, insurance details, and branch-specific notes.',
  },
  {
    title: 'How to restore a backup',
    category: 'Local Server',
    summary: 'Open System Health, confirm branch server connectivity, then restore the latest verified backup from the branch server.',
  },
  {
    title: 'How offline mode works',
    category: 'Offline Sync',
    summary: 'HealthFlow queues supported sales, inventory, and patient actions locally until internet and branch sync are available.',
  },
  {
    title: 'Common errors and solutions',
    category: 'Bug Report',
    summary: 'Capture the error text, refresh once, check System Health, and submit logs if the problem continues.',
  },
]

const announcements = [
  {
    title: 'Scheduled maintenance window',
    level: 'Maintenance',
    body: 'Cloud claim validation services are scheduled for maintenance this weekend.',
    date: '2026-07-04T08:00:00Z',
  },
  {
    title: 'NHIA workflow update',
    level: 'NHIA',
    body: 'Review claim diagnosis and medicine mapping before month-end exports.',
    date: '2026-07-03T13:30:00Z',
  },
  {
    title: 'Security reminder',
    level: 'Security',
    body: 'Administrators should review inactive staff accounts and branch access monthly.',
    date: '2026-07-01T09:15:00Z',
  },
]

const initialTickets = [
  {
    number: 'HF-20260704-00125',
    subject: 'Claim batch stuck in validation',
    category: 'NHIA Claims',
    priority: 'High',
    status: 'In Progress',
    updatedAt: '2026-07-04T10:20:00Z',
  },
  {
    number: 'HF-20260703-00118',
    subject: 'Receipt printer not detected',
    category: 'Pharmacy',
    priority: 'Medium',
    status: 'Waiting for User',
    updatedAt: '2026-07-03T16:45:00Z',
  },
]

const featureRequests = [
  { title: 'Add barcode support', requests: 28, status: 'Planned' },
  { title: 'Bulk NHIA claim correction tool', requests: 16, status: 'In Progress' },
  { title: 'Auto-email daily sales report', requests: 11, status: 'Released' },
]

const getBrowserName = () => {
  if (typeof navigator === 'undefined') return 'Unknown browser'
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'Microsoft Edge'
  if (ua.includes('Chrome/')) return 'Chrome'
  if (ua.includes('Firefox/')) return 'Firefox'
  if (ua.includes('Safari/')) return 'Safari'
  return 'Browser'
}

const getWindowsVersion = () => {
  if (typeof navigator === 'undefined') return 'Unknown'
  const platform = navigator.userAgentData?.platform || navigator.platform || ''
  return platform.includes('Win') ? 'Windows workstation' : platform || 'Unknown'
}

const getStoredValue = (keys, fallback) => {
  if (typeof window === 'undefined') return fallback
  for (const key of keys) {
    const value = window.localStorage.getItem(key) || window.sessionStorage.getItem(key)
    if (value) return value
  }
  return fallback
}

const formatBytes = (size) => {
  if (!Number.isFinite(size) || size <= 0) return '0 KB'
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const buildTicketNumber = (sequence) => {
  const dateKey = formatAppDateKey(new Date()).replaceAll('-', '')
  return `HF-${dateKey}-${String(sequence).padStart(5, '0')}`
}

const defaultTicket = {
  subject: '',
  category: 'NHIA Claims',
  priority: 'Medium',
  description: '',
  errorLogs: '',
}

export default function Support() {
  const { user, profile, displayName, role, branch } = useAuth()
  const { organization, supportLevel } = useTenant()
  const { notify } = useNotification()
  const [ticket, setTicket] = useState(defaultTicket)
  const [attachments, setAttachments] = useState([])
  const [tickets, setTickets] = useState(initialTickets)
  const [query, setQuery] = useState('')
  const [chatMessage, setChatMessage] = useState('')
  const [chatMessages, setChatMessages] = useState([
    { from: 'support', text: 'HealthFlow Support is ready. Share what is happening and we will guide you.' },
  ])
  const [supportOnline] = useState(() => typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [aiQuestion, setAiQuestion] = useState('')
  const [aiSuggestion, setAiSuggestion] = useState('')
  const [remoteRequested, setRemoteRequested] = useState(false)

  const diagnostics = useMemo(() => {
    const localServerVersion = getStoredValue(
      ['healthflow.localServerVersion', 'branchServerVersion', 'healthflow.branch.version'],
      'Not reported'
    )
    const lastSyncTime = getStoredValue(
      ['healthflow.lastSyncAt', 'lastSyncTime', 'offlineSync.lastSyncAt'],
      'No sync timestamp found'
    )

    return {
      'Facility name': organization?.name || organization?.facility_name || 'Unassigned facility',
      Branch: branch?.name || branch?.code || 'Main branch',
      'User name': displayName || profile?.full_name || user?.email || 'Authenticated user',
      Role: role || profile?.role || 'Unknown role',
      'App version': '1.0.0',
      'Local server version': localServerVersion,
      'Windows version': getWindowsVersion(),
      'Internet status': typeof navigator !== 'undefined' && navigator.onLine ? 'Online' : 'Offline',
      'Last sync time': lastSyncTime,
      'Error logs': ticket.errorLogs ? 'Included with ticket' : 'No manual logs added',
      'Browser/Desktop version': `${getBrowserName()} - ${typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown'}`,
      'Support level': supportLevel || 'standard',
    }
  }, [branch, displayName, organization, profile, role, supportLevel, ticket.errorLogs, user])

  const filteredArticles = knowledgeBase.filter((article) => {
    const haystack = `${article.title} ${article.category} ${article.summary}`.toLowerCase()
    return haystack.includes(query.toLowerCase())
  })

  const handleTicketChange = (event) => {
    const { name, value } = event.target
    setTicket((current) => ({ ...current, [name]: value }))
  }

  const handleFiles = (event) => {
    setAttachments(Array.from(event.target.files || []))
  }

  const submitTicket = (event) => {
    event.preventDefault()
    if (!ticket.subject.trim() || !ticket.description.trim()) {
      notify('Add a subject and description before submitting the support ticket.', 'warning')
      return
    }

    const number = buildTicketNumber(tickets.length + 126)
    const nextTicket = {
      number,
      subject: ticket.subject.trim(),
      category: ticket.category,
      priority: ticket.priority,
      status: 'Open',
      updatedAt: new Date().toISOString(),
      description: ticket.description.trim(),
      attachments: attachments.map((file) => ({ name: file.name, size: file.size, type: file.type })),
      diagnostics,
    }
    setTickets((current) => [nextTicket, ...current])
    setTicket(defaultTicket)
    setAttachments([])
    notify(`Support ticket ${number} created with diagnostics attached.`, 'success')
  }

  const sendChat = () => {
    const message = chatMessage.trim()
    if (!message) return

    setChatMessages((current) => [
      ...current,
      { from: 'user', text: message },
      {
        from: 'support',
        text: supportOnline
          ? 'Thanks. A HealthFlow support member will continue from here.'
          : 'Support is offline, so this message will be converted into a support ticket.',
      },
    ])
    if (!supportOnline) {
      const number = buildTicketNumber(tickets.length + 126)
      setTickets((current) => [
        {
          number,
          subject: `Offline chat: ${message.slice(0, 54)}`,
          category: 'Other',
          priority: 'Medium',
          status: 'Open',
          updatedAt: new Date().toISOString(),
          description: message,
          diagnostics,
        },
        ...current,
      ])
      notify(`Offline chat saved as ticket ${number}.`, 'info')
    }
    setChatMessage('')
  }

  const runAiAssistant = () => {
    const normalizedQuestion = aiQuestion.trim().toLowerCase()
    if (!normalizedQuestion) {
      setAiSuggestion('')
      return
    }

    const match = knowledgeBase.find((article) =>
      normalizedQuestion.split(/\s+/).some((word) => word.length > 3 && article.summary.toLowerCase().includes(word))
    )
    setAiSuggestion(
      match
        ? `${match.title}: ${match.summary}`
        : 'No exact article matched. Create a ticket and the support team will review the diagnostics.'
    )
  }

  return (
    <div className="support-page">
      <div className="support-header">
        <div>
          <span className="support-eyebrow"><LifeBuoy size={16} /> HealthFlow Support Center</span>
          <h1>Support</h1>
          <p>Submit tickets, chat with support, request remote assistance, search help articles, and track updates from one workspace.</p>
        </div>
        <div className={`support-presence ${supportOnline ? 'online' : 'offline'}`}>
          {supportOnline ? <Wifi size={18} /> : <WifiOff size={18} />}
          <span>{supportOnline ? 'Support online' : 'Offline ticket mode'}</span>
        </div>
      </div>

      <section className="support-emergency" aria-label="Emergency support">
        <a className="support-action" href="tel:0247654381"><Phone size={18} /> Call Support</a>
        <a className="support-action" href="https://wa.me/233247654381" target="_blank" rel="noreferrer"><MessageCircle size={18} /> WhatsApp Support</a>
        <a className="support-action" href="mailto:support@neondigitaltechnologies.com"><Mail size={18} /> Email Support</a>
        <button className="support-action primary" type="button" onClick={() => setRemoteRequested(true)}>
          <MonitorUp size={18} /> Request Remote Support
        </button>
      </section>

      {remoteRequested && (
        <div className="support-notice">
          <CheckCircle2 size={18} />
          Remote assistance requested. A support member will confirm consent and arrange AnyDesk or TeamViewer details.
        </div>
      )}

      <div className="support-main-grid">
        <section className="support-panel support-ticket-panel">
          <div className="support-section-title">
            <div>
              <h2>Submit a Support Ticket</h2>
              <p>Diagnostics are attached automatically when you submit.</p>
            </div>
            <FileText size={22} />
          </div>

          <form className="support-form" onSubmit={submitTicket}>
            <label>
              <span>Subject</span>
              <input name="subject" value={ticket.subject} onChange={handleTicketChange} placeholder="Short summary of the issue" />
            </label>
            <div className="support-form-row">
              <label>
                <span>Category</span>
                <select name="category" value={ticket.category} onChange={handleTicketChange}>
                  {categories.map((category) => <option key={category}>{category}</option>)}
                </select>
              </label>
              <label>
                <span>Priority</span>
                <select name="priority" value={ticket.priority} onChange={handleTicketChange}>
                  {priorities.map((priority) => <option key={priority}>{priority}</option>)}
                </select>
              </label>
            </div>
            <label>
              <span>Description</span>
              <textarea name="description" value={ticket.description} onChange={handleTicketChange} rows={5} placeholder="What happened, where it happened, and what you expected." />
            </label>
            <label>
              <span>Error logs (optional)</span>
              <textarea name="errorLogs" value={ticket.errorLogs} onChange={handleTicketChange} rows={3} placeholder="Paste CLAIM-it logs, console errors, or branch server errors." />
            </label>
            <label className="support-upload">
              <Upload size={20} />
              <span>Attach screenshots, PDFs, Excel files, error reports, or CLAIM-it logs</span>
              <input type="file" multiple accept="image/*,.pdf,.xls,.xlsx,.csv,.txt,.log,.json" onChange={handleFiles} />
            </label>
            {attachments.length > 0 && (
              <div className="support-file-list">
                {attachments.map((file) => (
                  <span key={`${file.name}-${file.size}`}>{file.name} ({formatBytes(file.size)})</span>
                ))}
              </div>
            )}
            <button className="btn btn-primary support-submit" type="submit">
              <Send size={17} /> Submit Ticket
            </button>
          </form>
        </section>

        <aside className="support-panel">
          <div className="support-section-title">
            <div>
              <h2>Automatic Diagnostics</h2>
              <p>Included with every ticket.</p>
            </div>
            <AlertTriangle size={22} />
          </div>
          <dl className="support-diagnostics">
            {Object.entries(diagnostics).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>

      <div className="support-tools-grid">
        <section className="support-panel">
          <div className="support-section-title">
            <div>
              <h2>AI Support Assistant</h2>
              <p>Try a fix before opening a ticket.</p>
            </div>
            <Sparkles size={22} />
          </div>
          <div className="support-ai">
            <textarea value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} rows={3} placeholder="Describe the issue..." />
            <button className="btn btn-secondary" type="button" onClick={runAiAssistant}>
              <Search size={16} /> Search Help
            </button>
            {aiSuggestion && <div className="support-ai-result">{aiSuggestion}</div>}
          </div>
        </section>

        <section className="support-panel">
          <div className="support-section-title">
            <div>
              <h2>Live Chat</h2>
              <p>{supportOnline ? 'Messages stay in the app.' : 'Offline messages become tickets.'}</p>
            </div>
            <MessageCircle size={22} />
          </div>
          <div className="support-chat-log">
            {chatMessages.map((message, index) => (
              <div key={`${message.from}-${index}`} className={`support-chat-message ${message.from}`}>
                {message.text}
              </div>
            ))}
          </div>
          <div className="support-chat-compose">
            <input value={chatMessage} onChange={(event) => setChatMessage(event.target.value)} placeholder="Type a message" onKeyDown={(event) => event.key === 'Enter' && sendChat()} />
            <button type="button" className="btn btn-primary" onClick={sendChat} aria-label="Send chat message" title="Send chat message">
              <Send size={17} />
            </button>
          </div>
        </section>
      </div>

      <div className="support-lists-grid">
        <section className="support-panel">
          <div className="support-section-title">
            <div>
              <h2>Knowledge Base</h2>
              <p>Search common workflows and fixes.</p>
            </div>
            <BookOpen size={22} />
          </div>
          <div className="support-search">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search articles" />
          </div>
          <div className="support-article-list">
            {filteredArticles.map((article) => (
              <article key={article.title}>
                <span>{article.category}</span>
                <h3>{article.title}</h3>
                <p>{article.summary}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="support-panel">
          <div className="support-section-title">
            <div>
              <h2>Ticket Tracking</h2>
              <p>Status visibility for submitted issues.</p>
            </div>
            <FileText size={22} />
          </div>
          <div className="support-ticket-list">
            {tickets.map((item) => (
              <article key={item.number}>
                <div>
                  <strong>{item.number}</strong>
                  <h3>{item.subject}</h3>
                  <p>{item.category} - {item.priority} priority</p>
                </div>
                <span className={`support-status status-${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span>
                <small>{formatAppDateTime(item.updatedAt)}</small>
              </article>
            ))}
          </div>
        </section>
      </div>

      <div className="support-lists-grid">
        <section className="support-panel">
          <div className="support-section-title">
            <div>
              <h2>Feature Requests</h2>
              <p>Track demand and delivery status.</p>
            </div>
            <Plus size={22} />
          </div>
          <div className="support-feature-list">
            {featureRequests.map((request) => (
              <article key={request.title}>
                <div>
                  <h3>{request.title}</h3>
                  <p>{request.requests} requests</p>
                </div>
                <span>{request.status}</span>
              </article>
            ))}
          </div>
        </section>

        <section className="support-panel">
          <div className="support-section-title">
            <div>
              <h2>Announcements</h2>
              <p>Important notices for facilities.</p>
            </div>
            <Bell size={22} />
          </div>
          <div className="support-announcement-list">
            {announcements.map((announcement) => (
              <article key={announcement.title}>
                <span>{announcement.level}</span>
                <h3>{announcement.title}</h3>
                <p>{announcement.body}</p>
                <small>{formatAppDateTime(announcement.date)}</small>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="support-panel support-dashboard-preview">
        <div className="support-section-title">
          <div>
            <h2>HealthFlow Team Dashboard</h2>
            <p>Admin portal capabilities this support flow is ready to feed.</p>
          </div>
          <MonitorUp size={22} />
        </div>
        <div className="support-dashboard-grid">
          {['All facility tickets', 'Search and filters', 'Staff assignment', 'Internal notes', 'Ticket history', 'Response times', 'Resolution times', 'Satisfaction ratings'].map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <div className="support-status-strip">
          {ticketStatuses.map((status) => <span key={status}>{status}</span>)}
        </div>
      </section>
    </div>
  )
}

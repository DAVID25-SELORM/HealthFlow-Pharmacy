import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Bell,
  CalendarDays,
  HeartPulse,
  MessageSquare,
  Plus,
  Printer,
  RefreshCcw,
  Search,
  Send,
} from 'lucide-react'
import { getAllPatients } from '../services/patientService'
import { formatAppDate, formatLocalDate } from '../utils/date'
import './PatientCare.css'

const STORAGE_KEYS = {
  vitals: 'healthflow.patientCare.vitals.v1',
  refills: 'healthflow.patientCare.refills.v1',
  followUps: 'healthflow.patientCare.followUps.v1',
  messages: 'healthflow.patientCare.messages.v1',
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

const tabs = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'vitals', label: 'Vitals', icon: HeartPulse },
  { id: 'refills', label: 'Refills', icon: RefreshCcw },
  { id: 'birthdays', label: 'Birthdays', icon: CalendarDays },
  { id: 'followups', label: 'Follow-ups', icon: Bell },
  { id: 'messages', label: 'Messages', icon: MessageSquare },
]

const chronicConditions = ['Hypertension', 'Diabetes', 'Asthma', 'HIV/AIDS', 'Mental Health', 'Other']
const messageChannels = ['SMS', 'WhatsApp', 'Email', 'In-app']

const emptyVitalsForm = {
  patientId: '',
  systolic: '',
  diastolic: '',
  pulse: '',
  temperature: '',
  respiratoryRate: '',
  spo2: '',
  weight: '',
  height: '',
  glucose: '',
  painScore: '',
  notes: '',
}

const emptyRefillForm = {
  patientId: '',
  medication: '',
  quantity: '',
  dailyDose: '1',
  dispensedDate: formatLocalDate(),
}

const emptyFollowUpForm = {
  patientId: '',
  condition: 'Hypertension',
  dueDate: formatLocalDate(),
  priority: 'Routine',
  notes: '',
}

const emptyMessageForm = {
  patientId: '',
  channel: 'SMS',
  template: 'refill',
  message: '',
}

const loadStoredList = (key) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const saveStoredList = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage can be unavailable in private or locked-down browser sessions.
  }
}

const createId = () =>
  globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`

const toNumber = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const addDays = (dateValue, days) => {
  const date = new Date(`${dateValue}T00:00:00`)
  if (Number.isNaN(date.getTime())) return ''
  date.setDate(date.getDate() + days)
  return formatLocalDate(date)
}

const normalizeDate = (value) => {
  const date = value ? new Date(`${value}T00:00:00`) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

const daysFromToday = (value) => {
  const date = normalizeDate(value)
  if (!date) return null
  const today = normalizeDate(formatLocalDate())
  return Math.ceil((date.getTime() - today.getTime()) / MS_PER_DAY)
}

const patientName = (patient) =>
  patient?.full_name || patient?.name || [patient?.first_name, patient?.last_name].filter(Boolean).join(' ') || 'Unnamed patient'

const patientMemberNumber = (patient) =>
  patient?.nhis_member_no || patient?.nhis_hin || patient?.insurance_id || patient?.member_no || '-'

const calcBmi = (weight, height) => {
  const kg = toNumber(weight)
  const cm = toNumber(height)
  if (!kg || !cm) return ''
  const bmi = kg / ((cm / 100) ** 2)
  return Number.isFinite(bmi) ? bmi.toFixed(1) : ''
}

const buildBirthdayInfo = (patient) => {
  const rawDob = patient?.date_of_birth || patient?.dateOfBirth || patient?.dob || ''
  const dob = normalizeDate(String(rawDob).slice(0, 10))
  if (!dob) return null

  const today = normalizeDate(formatLocalDate())
  const nextBirthday = new Date(today)
  nextBirthday.setMonth(dob.getMonth(), dob.getDate())
  if (nextBirthday < today) {
    nextBirthday.setFullYear(nextBirthday.getFullYear() + 1)
  }

  const daysUntil = Math.ceil((nextBirthday.getTime() - today.getTime()) / MS_PER_DAY)
  const age = nextBirthday.getFullYear() - dob.getFullYear()
  return {
    patient,
    daysUntil,
    age,
    date: formatLocalDate(nextBirthday),
  }
}

const getRefillStatus = (row) => {
  const days = daysFromToday(row.refillDate)
  if (days === null) return { label: 'Unscheduled', tone: 'neutral' }
  if (days < 0) return { label: 'Overdue', tone: 'danger' }
  if (days === 0) return { label: 'Due today', tone: 'warning' }
  if (days <= 7) return { label: `${days} day${days === 1 ? '' : 's'}`, tone: 'warning' }
  return { label: 'Upcoming', tone: 'success' }
}

const isAbnormalVitals = (row) => {
  const systolic = toNumber(row.systolic)
  const diastolic = toNumber(row.diastolic)
  const pulse = toNumber(row.pulse)
  const temperature = toNumber(row.temperature)
  const respiratoryRate = toNumber(row.respiratoryRate)
  const spo2 = toNumber(row.spo2)
  const glucose = toNumber(row.glucose)
  const painScore = toNumber(row.painScore)

  return Boolean(
    (systolic && (systolic >= 140 || systolic < 90)) ||
      (diastolic && (diastolic >= 90 || diastolic < 60)) ||
      (pulse && (pulse < 50 || pulse > 120)) ||
      (temperature && (temperature < 35.5 || temperature > 38)) ||
      (respiratoryRate && (respiratoryRate < 10 || respiratoryRate > 24)) ||
      (spo2 && spo2 < 94) ||
      (glucose && (glucose < 70 || glucose > 180)) ||
      (painScore && painScore >= 7)
  )
}

function PatientCare() {
  const [activeTab, setActiveTab] = useState('overview')
  const [patients, setPatients] = useState([])
  const [loadingPatients, setLoadingPatients] = useState(true)
  const [patientError, setPatientError] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [birthdayWindow, setBirthdayWindow] = useState(30)
  const [vitals, setVitals] = useState(() => loadStoredList(STORAGE_KEYS.vitals))
  const [refills, setRefills] = useState(() => loadStoredList(STORAGE_KEYS.refills))
  const [followUps, setFollowUps] = useState(() => loadStoredList(STORAGE_KEYS.followUps))
  const [messages, setMessages] = useState(() => loadStoredList(STORAGE_KEYS.messages))
  const [vitalsForm, setVitalsForm] = useState(emptyVitalsForm)
  const [refillForm, setRefillForm] = useState(emptyRefillForm)
  const [followUpForm, setFollowUpForm] = useState(emptyFollowUpForm)
  const [messageForm, setMessageForm] = useState(emptyMessageForm)

  useEffect(() => {
    let cancelled = false

    const loadPatients = async () => {
      setLoadingPatients(true)
      setPatientError('')
      try {
        const rows = await getAllPatients()
        if (!cancelled) setPatients(Array.isArray(rows) ? rows : [])
      } catch (error) {
        if (!cancelled) setPatientError(error.message || 'Unable to load patients.')
      } finally {
        if (!cancelled) setLoadingPatients(false)
      }
    }

    loadPatients()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => saveStoredList(STORAGE_KEYS.vitals, vitals), [vitals])
  useEffect(() => saveStoredList(STORAGE_KEYS.refills, refills), [refills])
  useEffect(() => saveStoredList(STORAGE_KEYS.followUps, followUps), [followUps])
  useEffect(() => saveStoredList(STORAGE_KEYS.messages, messages), [messages])

  const patientMap = useMemo(() => {
    const map = new Map()
    patients.forEach((patient) => map.set(String(patient.id), patient))
    return map
  }, [patients])

  const filteredPatients = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return patients
    return patients.filter((patient) =>
      [
        patientName(patient),
        patientMemberNumber(patient),
        patient.phone,
        patient.folder_no,
        patient.insurance_provider,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term))
    )
  }, [patients, searchTerm])

  const birthdays = useMemo(() => {
    return patients
      .map(buildBirthdayInfo)
      .filter(Boolean)
      .sort((a, b) => a.daysUntil - b.daysUntil)
  }, [patients])

  const upcomingBirthdays = birthdays.filter((item) => item.daysUntil <= birthdayWindow)
  const dueRefills = refills
    .filter((row) => {
      const days = daysFromToday(row.refillDate)
      return days !== null && days <= 7
    })
    .sort((a, b) => (daysFromToday(a.refillDate) || 0) - (daysFromToday(b.refillDate) || 0))
  const dueFollowUps = followUps
    .filter((row) => {
      const days = daysFromToday(row.dueDate)
      return days !== null && days <= 7
    })
    .sort((a, b) => (daysFromToday(a.dueDate) || 0) - (daysFromToday(b.dueDate) || 0))
  const vitalsAlerts = vitals.filter(isAbnormalVitals)

  const selectPatientOptions = (placeholder = 'Select patient') => (
    <>
      <option value="">{placeholder}</option>
      {patients.map((patient) => (
        <option key={patient.id} value={patient.id}>
          {patientName(patient)} - {patientMemberNumber(patient)}
        </option>
      ))}
    </>
  )

  const addVital = (event) => {
    event.preventDefault()
    if (!vitalsForm.patientId) return
    const row = {
      id: createId(),
      ...vitalsForm,
      bmi: calcBmi(vitalsForm.weight, vitalsForm.height),
      recordedAt: new Date().toISOString(),
    }
    setVitals((current) => [row, ...current])
    setVitalsForm(emptyVitalsForm)
  }

  const addRefill = (event) => {
    event.preventDefault()
    if (!refillForm.patientId || !refillForm.medication) return
    const quantity = toNumber(refillForm.quantity) || 0
    const dailyDose = toNumber(refillForm.dailyDose) || 1
    const daysSupplied = quantity > 0 && dailyDose > 0 ? Math.ceil(quantity / dailyDose) : 0
    const row = {
      id: createId(),
      ...refillForm,
      daysSupplied,
      refillDate: daysSupplied ? addDays(refillForm.dispensedDate, daysSupplied) : refillForm.dispensedDate,
      createdAt: new Date().toISOString(),
    }
    setRefills((current) => [row, ...current])
    setRefillForm(emptyRefillForm)
  }

  const addFollowUp = (event) => {
    event.preventDefault()
    if (!followUpForm.patientId || !followUpForm.dueDate) return
    setFollowUps((current) => [{ id: createId(), ...followUpForm, createdAt: new Date().toISOString() }, ...current])
    setFollowUpForm(emptyFollowUpForm)
  }

  const sendMessage = (event) => {
    event.preventDefault()
    if (!messageForm.patientId || !messageForm.message.trim()) return
    setMessages((current) => [
      { id: createId(), ...messageForm, status: 'Queued', createdAt: new Date().toISOString() },
      ...current,
    ])
    setMessageForm(emptyMessageForm)
  }

  const selectedMessagePatient = patientMap.get(String(messageForm.patientId))

  useEffect(() => {
    if (!selectedMessagePatient) return
    const name = patientName(selectedMessagePatient)
    const templates = {
      birthday: `Happy Birthday ${name}. We wish you good health and a wonderful year ahead.`,
      refill: `Hello ${name}, your medication refill is due soon. Please contact the pharmacy for support.`,
      followup: `Hello ${name}, this is a reminder for your scheduled health follow-up.`,
      screening: `Hello ${name}, please remember your scheduled health screening.`,
    }
    setMessageForm((current) => ({ ...current, message: templates[current.template] || current.message }))
  }, [messageForm.patientId, messageForm.template, selectedMessagePatient])

  const renderStatus = (label, tone = 'neutral') => (
    <span className={`care-status care-status--${tone}`}>{label}</span>
  )

  return (
    <div className="patient-care-page">
      <div className="page-header">
        <div>
          <h1>Patient Care</h1>
          <p className="page-subtitle">Vitals, refills, birthdays, follow-ups, and patient messaging</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
          <Printer size={16} />
          Print
        </button>
      </div>

      {patientError && <div className="care-alert" role="alert">{patientError}</div>}

      <div className="care-tabs" role="tablist" aria-label="Patient care tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`care-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <tab.icon size={16} />
            {tab.label}
          </button>
        ))}
      </div>

      <div className="care-summary-grid">
        <div className="care-summary-card">
          <span>Patients</span>
          <strong>{patients.length}</strong>
        </div>
        <div className="care-summary-card care-summary-card--warning">
          <span>Refills due</span>
          <strong>{dueRefills.length}</strong>
        </div>
        <div className="care-summary-card care-summary-card--danger">
          <span>Vitals alerts</span>
          <strong>{vitalsAlerts.length}</strong>
        </div>
        <div className="care-summary-card care-summary-card--success">
          <span>Birthdays today</span>
          <strong>{birthdays.filter((item) => item.daysUntil === 0).length}</strong>
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="care-grid care-grid--two">
          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Today</h2>
              <span>{formatAppDate(formatLocalDate())}</span>
            </div>
            <div className="care-worklist">
              {dueRefills.slice(0, 5).map((row) => {
                const patient = patientMap.get(String(row.patientId))
                const status = getRefillStatus(row)
                return (
                  <div key={row.id} className="care-worklist-row">
                    <div>
                      <strong>{patientName(patient)}</strong>
                      <span>{row.medication}</span>
                    </div>
                    {renderStatus(status.label, status.tone)}
                  </div>
                )
              })}
              {dueFollowUps.slice(0, 5).map((row) => {
                const patient = patientMap.get(String(row.patientId))
                return (
                  <div key={row.id} className="care-worklist-row">
                    <div>
                      <strong>{patientName(patient)}</strong>
                      <span>{row.condition}</span>
                    </div>
                    {renderStatus(daysFromToday(row.dueDate) < 0 ? 'Overdue' : 'Due soon', daysFromToday(row.dueDate) < 0 ? 'danger' : 'warning')}
                  </div>
                )
              })}
              {dueRefills.length === 0 && dueFollowUps.length === 0 && (
                <div className="care-empty">No due care tasks.</div>
              )}
            </div>
          </section>

          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Patient Registry</h2>
              <span>{filteredPatients.length} shown</span>
            </div>
            <label className="care-search">
              <Search size={17} />
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search patients by name, member no, phone..."
              />
            </label>
            <div className="care-patient-list">
              {loadingPatients ? (
                <div className="care-empty">Loading patients...</div>
              ) : filteredPatients.length === 0 ? (
                <div className="care-empty">No patients found.</div>
              ) : (
                filteredPatients.map((patient) => (
                  <div key={patient.id} className="care-patient-row">
                    <div>
                      <strong>{patientName(patient)}</strong>
                      <span>{patientMemberNumber(patient)}</span>
                    </div>
                    <span>{patient.phone || patient.insurance_provider || '-'}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'vitals' && (
        <div className="care-grid care-grid--form">
          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Record Vitals</h2>
              <span>BMI {calcBmi(vitalsForm.weight, vitalsForm.height) || '-'}</span>
            </div>
            <form className="care-form" onSubmit={addVital}>
              <label>
                Patient
                <select value={vitalsForm.patientId} onChange={(event) => setVitalsForm({ ...vitalsForm, patientId: event.target.value })}>
                  {selectPatientOptions()}
                </select>
              </label>
              <div className="care-form-grid">
                <label>BP Systolic<input type="number" value={vitalsForm.systolic} onChange={(event) => setVitalsForm({ ...vitalsForm, systolic: event.target.value })} /></label>
                <label>BP Diastolic<input type="number" value={vitalsForm.diastolic} onChange={(event) => setVitalsForm({ ...vitalsForm, diastolic: event.target.value })} /></label>
                <label>Pulse<input type="number" value={vitalsForm.pulse} onChange={(event) => setVitalsForm({ ...vitalsForm, pulse: event.target.value })} /></label>
                <label>Temp C<input type="number" step="0.1" value={vitalsForm.temperature} onChange={(event) => setVitalsForm({ ...vitalsForm, temperature: event.target.value })} /></label>
                <label>Resp Rate<input type="number" value={vitalsForm.respiratoryRate} onChange={(event) => setVitalsForm({ ...vitalsForm, respiratoryRate: event.target.value })} /></label>
                <label>SpO2 %<input type="number" value={vitalsForm.spo2} onChange={(event) => setVitalsForm({ ...vitalsForm, spo2: event.target.value })} /></label>
                <label>Weight kg<input type="number" step="0.1" value={vitalsForm.weight} onChange={(event) => setVitalsForm({ ...vitalsForm, weight: event.target.value })} /></label>
                <label>Height cm<input type="number" step="0.1" value={vitalsForm.height} onChange={(event) => setVitalsForm({ ...vitalsForm, height: event.target.value })} /></label>
                <label>Glucose<input type="number" value={vitalsForm.glucose} onChange={(event) => setVitalsForm({ ...vitalsForm, glucose: event.target.value })} /></label>
                <label>Pain 0-10<input type="number" min="0" max="10" value={vitalsForm.painScore} onChange={(event) => setVitalsForm({ ...vitalsForm, painScore: event.target.value })} /></label>
              </div>
              <label>
                Notes
                <textarea value={vitalsForm.notes} onChange={(event) => setVitalsForm({ ...vitalsForm, notes: event.target.value })} rows="3" />
              </label>
              <button type="submit" className="btn btn-primary">
                <Plus size={16} />
                Save Vitals
              </button>
            </form>
          </section>

          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Vitals History</h2>
              <span>{vitals.length} records</span>
            </div>
            <div className="care-table-wrap">
              <table className="care-table">
                <thead>
                  <tr><th>Patient</th><th>BP</th><th>Pulse</th><th>Temp</th><th>BMI</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {vitals.map((row) => {
                    const patient = patientMap.get(String(row.patientId))
                    return (
                      <tr key={row.id}>
                        <td><strong>{patientName(patient)}</strong><span>{formatAppDate(row.recordedAt)}</span></td>
                        <td>{row.systolic || '-'}/{row.diastolic || '-'}</td>
                        <td>{row.pulse || '-'}</td>
                        <td>{row.temperature || '-'}</td>
                        <td>{row.bmi || '-'}</td>
                        <td>{isAbnormalVitals(row) ? renderStatus('Review', 'danger') : renderStatus('Normal', 'success')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {vitals.length === 0 && <div className="care-empty">No vitals recorded.</div>}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'refills' && (
        <div className="care-grid care-grid--form">
          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Medication Refill</h2>
              <span>{refills.length} active</span>
            </div>
            <form className="care-form" onSubmit={addRefill}>
              <label>Patient<select value={refillForm.patientId} onChange={(event) => setRefillForm({ ...refillForm, patientId: event.target.value })}>{selectPatientOptions()}</select></label>
              <label>Medication<input value={refillForm.medication} onChange={(event) => setRefillForm({ ...refillForm, medication: event.target.value })} /></label>
              <div className="care-form-grid">
                <label>Quantity<input type="number" value={refillForm.quantity} onChange={(event) => setRefillForm({ ...refillForm, quantity: event.target.value })} /></label>
                <label>Daily Dose<input type="number" step="0.25" value={refillForm.dailyDose} onChange={(event) => setRefillForm({ ...refillForm, dailyDose: event.target.value })} /></label>
                <label>Dispensed Date<input type="date" value={refillForm.dispensedDate} onChange={(event) => setRefillForm({ ...refillForm, dispensedDate: event.target.value })} /></label>
                <label>Expected Date<input readOnly value={addDays(refillForm.dispensedDate, Math.ceil((toNumber(refillForm.quantity) || 0) / (toNumber(refillForm.dailyDose) || 1))) || refillForm.dispensedDate} /></label>
              </div>
              <div className="care-chip-row">
                <span>7 days before</span>
                <span>3 days before</span>
                <span>On due date</span>
                <span>Overdue</span>
              </div>
              <button type="submit" className="btn btn-primary">
                <Plus size={16} />
                Add Refill
              </button>
            </form>
          </section>

          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Refill Queue</h2>
              <span>{dueRefills.length} due soon</span>
            </div>
            <div className="care-table-wrap">
              <table className="care-table">
                <thead>
                  <tr><th>Patient</th><th>Medication</th><th>Days</th><th>Refill Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {refills.map((row) => {
                    const patient = patientMap.get(String(row.patientId))
                    const status = getRefillStatus(row)
                    return (
                      <tr key={row.id}>
                        <td><strong>{patientName(patient)}</strong><span>{patientMemberNumber(patient)}</span></td>
                        <td>{row.medication}</td>
                        <td>{row.daysSupplied || '-'}</td>
                        <td>{formatAppDate(row.refillDate)}</td>
                        <td>{renderStatus(status.label, status.tone)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {refills.length === 0 && <div className="care-empty">No refill reminders.</div>}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'birthdays' && (
        <section className="care-panel">
          <div className="care-panel-header">
            <h2>Birthdays</h2>
            <select value={birthdayWindow} onChange={(event) => setBirthdayWindow(Number(event.target.value))}>
              <option value={7}>Next 7 days</option>
              <option value={14}>Next 14 days</option>
              <option value={30}>Next 30 days</option>
            </select>
          </div>
          <div className="care-table-wrap">
            <table className="care-table">
              <thead>
                <tr><th>Patient</th><th>Member No</th><th>Birthday</th><th>Turning</th><th>Action</th></tr>
              </thead>
              <tbody>
                {upcomingBirthdays.map((item) => (
                  <tr key={item.patient.id}>
                    <td><strong>{patientName(item.patient)}</strong><span>{item.patient.phone || '-'}</span></td>
                    <td>{patientMemberNumber(item.patient)}</td>
                    <td>{item.daysUntil === 0 ? 'Today' : formatAppDate(item.date)}</td>
                    <td>{item.age}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-small"
                        onClick={() => {
                          setActiveTab('messages')
                          setMessageForm({ patientId: String(item.patient.id), channel: 'SMS', template: 'birthday', message: '' })
                        }}
                      >
                        <Send size={14} />
                        Message
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {upcomingBirthdays.length === 0 && <div className="care-empty">No birthdays in this period.</div>}
          </div>
        </section>
      )}

      {activeTab === 'followups' && (
        <div className="care-grid care-grid--form">
          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Follow-up Registry</h2>
              <span>{followUps.length} records</span>
            </div>
            <form className="care-form" onSubmit={addFollowUp}>
              <label>Patient<select value={followUpForm.patientId} onChange={(event) => setFollowUpForm({ ...followUpForm, patientId: event.target.value })}>{selectPatientOptions()}</select></label>
              <div className="care-form-grid">
                <label>Condition<select value={followUpForm.condition} onChange={(event) => setFollowUpForm({ ...followUpForm, condition: event.target.value })}>{chronicConditions.map((item) => <option key={item}>{item}</option>)}</select></label>
                <label>Due Date<input type="date" value={followUpForm.dueDate} onChange={(event) => setFollowUpForm({ ...followUpForm, dueDate: event.target.value })} /></label>
                <label>Priority<select value={followUpForm.priority} onChange={(event) => setFollowUpForm({ ...followUpForm, priority: event.target.value })}><option>Routine</option><option>High</option><option>Urgent</option></select></label>
              </div>
              <label>Notes<textarea rows="3" value={followUpForm.notes} onChange={(event) => setFollowUpForm({ ...followUpForm, notes: event.target.value })} /></label>
              <button type="submit" className="btn btn-primary">
                <Plus size={16} />
                Add Follow-up
              </button>
            </form>
          </section>

          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Due Follow-ups</h2>
              <span>{dueFollowUps.length} due soon</span>
            </div>
            <div className="care-table-wrap">
              <table className="care-table">
                <thead>
                  <tr><th>Patient</th><th>Condition</th><th>Due Date</th><th>Priority</th></tr>
                </thead>
                <tbody>
                  {followUps.map((row) => {
                    const patient = patientMap.get(String(row.patientId))
                    const days = daysFromToday(row.dueDate)
                    return (
                      <tr key={row.id}>
                        <td><strong>{patientName(patient)}</strong><span>{patientMemberNumber(patient)}</span></td>
                        <td>{row.condition}</td>
                        <td>{formatAppDate(row.dueDate)}</td>
                        <td>{renderStatus(row.priority, days < 0 || row.priority === 'Urgent' ? 'danger' : row.priority === 'High' ? 'warning' : 'neutral')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {followUps.length === 0 && <div className="care-empty">No follow-ups recorded.</div>}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'messages' && (
        <div className="care-grid care-grid--form">
          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Patient Message</h2>
              <span>{messages.length} queued</span>
            </div>
            <form className="care-form" onSubmit={sendMessage}>
              <label>Patient<select value={messageForm.patientId} onChange={(event) => setMessageForm({ ...messageForm, patientId: event.target.value })}>{selectPatientOptions()}</select></label>
              <div className="care-form-grid">
                <label>Channel<select value={messageForm.channel} onChange={(event) => setMessageForm({ ...messageForm, channel: event.target.value })}>{messageChannels.map((item) => <option key={item}>{item}</option>)}</select></label>
                <label>Template<select value={messageForm.template} onChange={(event) => setMessageForm({ ...messageForm, template: event.target.value })}><option value="refill">Refill</option><option value="birthday">Birthday</option><option value="followup">Follow-up</option><option value="screening">Screening</option></select></label>
              </div>
              <label>Message<textarea rows="5" value={messageForm.message} onChange={(event) => setMessageForm({ ...messageForm, message: event.target.value })} /></label>
              <button type="submit" className="btn btn-primary">
                <Send size={16} />
                Queue Message
              </button>
            </form>
          </section>

          <section className="care-panel">
            <div className="care-panel-header">
              <h2>Message Log</h2>
              <span>{messages.length} entries</span>
            </div>
            <div className="care-table-wrap">
              <table className="care-table">
                <thead>
                  <tr><th>Patient</th><th>Channel</th><th>Message</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {messages.map((row) => {
                    const patient = patientMap.get(String(row.patientId))
                    return (
                      <tr key={row.id}>
                        <td><strong>{patientName(patient)}</strong><span>{formatAppDate(row.createdAt)}</span></td>
                        <td>{row.channel}</td>
                        <td className="care-message-cell">{row.message}</td>
                        <td>{renderStatus(row.status, 'neutral')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {messages.length === 0 && <div className="care-empty">No messages queued.</div>}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export default PatientCare

export const cents = value => Math.round(Number(value || 0) * 100)
export function collectionsReport(data, facility = '', from = '', to = '') {
 const invoices = (data.invoices || []).filter(i => !facility || i.organization_id === facility)
 const index = new Map(invoices.map(i => [i.id, i]))
 const rows = (data.payments || []).filter(p => index.has(p.invoice_id)).map(p => {
  const i = index.get(p.invoice_id)
  const date = (p.status === 'approved' ? p.received_on || p.reviewed_at || i.paid_at : p.submitted_at)?.slice(0,10) || ''
  return { ...p, date, facility: i.facility, kind: i.kind || 'subscription', period: i.period, dateBasis: p.status !== 'approved' ? 'Submission date' : p.received_on ? 'Received date' : 'Confirmation date', reference: p.receipt_reference || p.transaction_reference }
 }).filter(p => (!from || p.date >= from) && (!to || p.date <= to)).sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
 const sum = predicate => rows.filter(predicate).reduce((n,p) => n + cents(p.amount),0)
 return { rows, received: sum(p => p.status === 'approved'), subscription: sum(p => p.status === 'approved' && p.kind === 'subscription'), onboarding: sum(p => p.status === 'approved' && p.kind === 'onboarding'), pending: sum(p => p.status === 'pending'), outstanding: invoices.filter(i => !i.paid_at).reduce((n,i) => n+cents(i.amount),0) }
}
export function collectionsCsv(rows) {
 const cell = value => '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"','""') + '"'
 return [['Date','Date basis','Facility','Type','Billing month','Reference','Status','Amount GHS','Invoice ID','Payment ID'], ...rows.map(p => [p.date,p.dateBasis,p.facility,p.kind,p.period?.slice(0,7),p.reference,p.status,(cents(p.amount)/100).toFixed(2),p.invoice_id,p.id])].map(row => row.map(cell).join(',')).join('\r\n')
}

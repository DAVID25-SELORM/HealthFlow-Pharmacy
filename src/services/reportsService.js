import { invokeTierAccess } from './tierAccessService'

export const getReportBundle = async (startDate, endDate) => {
  return await invokeTierAccess({
    action: 'get_report_bundle',
    startDate,
    endDate,
  })
}

export const downloadCsv = (filename, headers, rows) => {
  const csv = [headers, ...rows]
    .map((row) =>
      row
        .map((cell) => {
          const value = cell ?? ''
          const escaped = String(value).replace(/"/g, '""')
          return `"${escaped}"`
        })
        .join(',')
    )
    .join('\n')

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.setAttribute('download', filename)
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

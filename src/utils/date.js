const padDatePart = (value) => String(value).padStart(2, '0')

export const formatLocalDate = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)

  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join('-')
}

export const getFirstDayOfLocalMonth = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  return formatLocalDate(new Date(date.getFullYear(), date.getMonth(), 1))
}

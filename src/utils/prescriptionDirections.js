export const autoSpaceDoseValue = (value) => String(value ?? '')
  .replace(/(\d)([A-Za-z])/g, '$1 $2')


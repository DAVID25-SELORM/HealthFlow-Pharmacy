import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync('src/pages/Nhis.css', 'utf8').replace(/\r\n/g, '\n')

it('stacks the CC code input and the Generate/Validate button on phones so the 5 digits stay visible', () => {
  const phone = css.slice(css.lastIndexOf('@media (max-width: 520px) {\n  .nhis-code-field {'))
  expect(phone).toMatch(/\.nhis-code-field \{\n\s+flex-direction: column;/)
  expect(phone).toMatch(/\.nhis-code-field \.form-input \{\n\s+width: 100%;/)
  expect(phone).toMatch(/\.nhis-code-field \.nhis-code-generate \{\n\s+width: 100%;/)
})

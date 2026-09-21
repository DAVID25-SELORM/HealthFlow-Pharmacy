import { createReadStream, openSync, readSync, closeSync } from 'node:fs'
import { createInflate } from 'node:zlib'

// Development-only, bounded-memory CXF reader for files too large to inflate into
// one buffer (attachment-heavy full-month exports). Same PHP subset and strictness
// as parsePhp in cxf-reader.mjs, but strings longer than `maxInlineString` bytes
// (attachment payloads) are consumed and replaced by a length-only placeholder, so
// memory stays proportional to the structure, not to the attachments.
// Production CXF generation does not use this module.
export class BigPhpString {
  constructor(length) { this.length = length }
}

class ByteSource {
  constructor(chunks) {
    this.iterator = chunks[Symbol.asyncIterator]()
    this.buf = Buffer.alloc(0)
    this.pos = 0
    this.eof = false
    this.consumed = 0
  }
  async more() {
    if (this.eof) return false
    const { value, done } = await this.iterator.next()
    if (done) { this.eof = true; return false }
    this.consumed += this.pos
    this.buf = this.pos >= this.buf.length ? value : Buffer.concat([this.buf.subarray(this.pos), value])
    this.pos = 0
    return true
  }
  async ensure(count) {
    while (this.buf.length - this.pos < count) if (!await this.more()) throw new Error('Truncated PHP value')
  }
  async byte() {
    await this.ensure(1)
    return this.buf[this.pos++]
  }
  async take(expected) {
    await this.ensure(expected.length)
    if (this.buf.subarray(this.pos, this.pos + expected.length).toString() !== expected) {
      throw new Error(`Invalid PHP delimiter at byte ${this.consumed + this.pos}`)
    }
    this.pos += expected.length
  }
  async until(delimiter) {
    for (;;) {
      const end = this.buf.indexOf(delimiter, this.pos)
      if (end >= 0) {
        const value = this.buf.toString('utf8', this.pos, end)
        this.pos = end + 1
        return value
      }
      if (this.buf.length - this.pos > 64) throw new Error('Truncated PHP value')
      if (!await this.more()) throw new Error('Truncated PHP value')
    }
  }
  async skip(count) {
    let remaining = count
    while (remaining > 0) {
      if (this.pos >= this.buf.length && !await this.more()) throw new Error('Truncated PHP value')
      const step = Math.min(remaining, this.buf.length - this.pos)
      this.pos += step
      remaining -= step
    }
  }
  async atEnd() {
    return this.pos >= this.buf.length && !await this.more()
  }
}

async function readValue(source, maxInlineString, depth = 0) {
  if (depth > 100) throw new Error('PHP nesting limit exceeded')
  const type = String.fromCharCode(await source.byte())
  if (type === 'N') { await source.take(';'); return null }
  await source.take(':')
  if (type === 'b') {
    const value = await source.until(';')
    if (!['0', '1'].includes(value)) throw new Error('Invalid PHP boolean')
    return value === '1'
  }
  if (type === 'i' || type === 'd') {
    const value = Number(await source.until(';'))
    if (!Number.isFinite(value)) throw new Error('Invalid PHP number')
    return value
  }
  if (type === 's') {
    const length = Number(await source.until(':'))
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid PHP string length')
    await source.take('"')
    let value
    if (length > maxInlineString) {
      await source.skip(length)
      value = new BigPhpString(length)
    } else {
      await source.ensure(length)
      value = Buffer.from(source.buf.subarray(source.pos, source.pos + length))
      source.pos += length
    }
    await source.take('";')
    return value
  }
  if (type === 'a') {
    const length = Number(await source.until(':'))
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid PHP array length')
    await source.take('{')
    const value = new Map()
    for (let index = 0; index < length; index++) {
      const rawKey = await readValue(source, maxInlineString, depth + 1)
      const key = Buffer.isBuffer(rawKey) ? rawKey.toString('utf8') : rawKey
      if (typeof key !== 'string' && !Number.isInteger(key)) throw new Error('Invalid PHP key')
      if (value.has(key)) throw new Error('Duplicate PHP key')
      value.set(key, await readValue(source, maxInlineString, depth + 1))
    }
    await source.take('}')
    return value
  }
  throw new Error(`Unsupported PHP type at byte ${source.consumed + source.pos - 2}`)
}

export async function parsePhpStream(chunks, { maxInlineString = 1 << 20 } = {}) {
  const source = new ByteSource(chunks)
  const value = await readValue(source, maxInlineString)
  if (!await source.atEnd()) throw new Error('Trailing PHP bytes')
  return { value, decompressedBytes: source.consumed + source.pos }
}

export async function readCxfStream(path, options = {}) {
  const header = Buffer.alloc(3)
  const fd = openSync(path, 'r')
  try { readSync(fd, header, 0, 3, 0) } finally { closeSync(fd) }
  if (!header.equals(Buffer.from([1, 2, 25]))) throw new Error('Unrecognized CXF envelope')
  const inflated = createReadStream(path, { start: 3, highWaterMark: 1 << 20 }).pipe(createInflate({ chunkSize: 1 << 20 }))
  const { value, decompressedBytes } = await parsePhpStream(inflated, options)
  return { bundle: value, decompressedBytes }
}

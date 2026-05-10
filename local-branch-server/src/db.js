import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'

const schemaPath = new URL('./schema.sql', import.meta.url)

fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true })

export const db = new Database(config.sqlitePath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(fs.readFileSync(schemaPath, 'utf8'))

export const nowIso = () => new Date().toISOString()

export const createId = () => crypto.randomUUID()

export const parseJson = (value, fallback = null) => {
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export const json = (value) => JSON.stringify(value ?? null)

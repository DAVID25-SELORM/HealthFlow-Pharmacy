import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const createResponse = () => {
  const response = {
    body: null,
    headers: {},
    statusCode: 200,
    status: vi.fn((statusCode) => {
      response.statusCode = statusCode
      return response
    }),
    setHeader: vi.fn((name, value) => {
      response.headers[String(name).toLowerCase()] = value
    }),
    json: vi.fn((body) => {
      response.body = body
      return response
    }),
    end: vi.fn(),
  }
  return response
}

const createJsonRequest = (body) => {
  const request = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
  request.method = 'POST'
  request.query = { path: ['prescriptions'] }
  request.headers = {
    host: 'healthflowcloud.com',
    'x-hms-api-token': 'test-token',
  }
  request.url = '/prescriptions'
  return request
}

describe('HMS API prescriptions', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    delete process.env.HMS_API_TOKEN
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })

  it('recomputes prescription item totals instead of trusting client totals', async () => {
    process.env.HMS_API_TOKEN = 'test-token'
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key'

    let insertedClaim = null
    let insertedClaimItems = null
    const patient = {
      id: '11111111-1111-4111-8111-111111111111',
      full_name: 'Aba Mensah',
      phone: '0240000000',
      insurance_provider: 'private',
      insurance_id: 'private',
    }

    const supabase = {
      from: vi.fn((table) => {
        if (table === 'patients') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                ilike: vi.fn(() => ({
                  limit: vi.fn(async () => ({ data: [], error: null })),
                })),
              })),
            })),
            insert: vi.fn((rows) => ({
              select: vi.fn(() => ({
                single: vi.fn(async () => ({ data: { ...patient, ...rows[0] }, error: null })),
              })),
            })),
          }
        }

        if (table === 'claims') {
          return {
            insert: vi.fn((rows) => {
              insertedClaim = rows[0]
              return {
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: { ...rows[0], id: 'claim-1', claim_number: rows[0].claim_number },
                    error: null,
                  })),
                })),
              }
            }),
          }
        }

        if (table === 'claim_items') {
          return {
            insert: vi.fn((rows) => {
              insertedClaimItems = rows
              return {
                select: vi.fn(async () => ({ data: rows, error: null })),
              }
            }),
          }
        }

        throw new Error(`Unexpected table ${table}`)
      }),
    }

    vi.doMock('@supabase/supabase-js', () => ({
      createClient: vi.fn(() => supabase),
    }))

    const { default: handler } = await import('./hms-api/handler.js')
    const response = createResponse()

    await handler(createJsonRequest({
      prescription_number: 'HMS-TEST-001',
      patient: {
        id: patient.id,
        full_name: patient.full_name,
        phone: patient.phone,
      },
      items: [{
        drug_id: 'drug-1',
        drug_name: 'Paracetamol',
        quantity: 2,
        unit_price: 3.5,
        total_price: 999,
      }],
    }), response)

    expect(response.body).toMatchObject({ prescription: expect.any(Object) })
    expect(response.statusCode).toBe(201)
    expect(insertedClaim.total_amount).toBe(7)
    expect(insertedClaimItems).toMatchObject([{
      drug_id: 'drug-1',
      drug_name: 'Paracetamol',
      quantity: 2,
      unit_price: 3.5,
      total_price: 7,
      claim_id: 'claim-1',
    }])
    expect(response.body.prescription.totalAmount).toBe(7)
  })
})

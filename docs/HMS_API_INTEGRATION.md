# HealthFlow HMS API Integration

HealthFlow exposes a server-side REST API for Hospital Management System integrations at:

```text
https://<your-healthflow-domain>/hms-api
```

## Authentication

All endpoints except `GET /hms-api/health` require an API token.

Send either:

```http
x-hms-api-token: <HMS_API_TOKEN>
```

or:

```http
Authorization: Bearer <HMS_API_TOKEN>
```

Configure these server environment variables in Vercel:

```text
SUPABASE_SERVICE_ROLE_KEY=<Supabase service role key>
HMS_API_TOKEN=<long random shared secret>
HMS_API_ALLOWED_ORIGINS=https://your-hms.example.com
```

`SUPABASE_URL` is optional when `VITE_SUPABASE_URL` is already configured.

## Endpoints

### Health Check

```http
GET /hms-api/health
```

Returns API configuration status without exposing secrets.

### Medicine Search

```http
GET /hms-api/medicines?search=amoxicillin&in_stock=true&limit=20
```

Optional query parameters:

- `search`: medicine, brand, generic, batch, or NHIS code text
- `in_stock`: `true` to return only available stock
- `branch_id`: restrict stock to a branch when branch inventory is enabled
- `limit`: defaults to `50`, maximum `100`

### Get Medicine

```http
GET /hms-api/medicines/{medicineId}
```

### Upsert Patient

```http
POST /hms-api/patients
Content-Type: application/json
```

```json
{
  "full_name": "Ama Mensah",
  "phone": "0244000000",
  "email": "ama@example.com",
  "date_of_birth": "1990-04-12",
  "gender": "female",
  "address": "Accra",
  "insurance_provider": "NHIS",
  "insurance_id": "GHA-000000000-0",
  "allergies": "Penicillin",
  "medical_notes": "HMS folder: OPD-1029"
}
```

The API updates an existing patient by Supabase `id`, `insurance_id`, or matching `phone` and `full_name`; otherwise it creates a new patient.

### Send Prescription

```http
POST /hms-api/prescriptions
Content-Type: application/json
```

```json
{
  "prescription_number": "HMS-RX-2026-0001",
  "external_prescription_id": "RX-0001",
  "encounter_id": "VISIT-1002",
  "service_date": "2026-06-24",
  "prescriber_name": "Dr. K. Owusu",
  "patient": {
    "full_name": "Ama Mensah",
    "phone": "0244000000",
    "insurance_provider": "NHIS",
    "insurance_id": "GHA-000000000-0"
  },
  "items": [
    {
      "drug_id": "optional-healthflow-drug-uuid",
      "drug_name": "Amoxicillin 500mg capsule",
      "quantity": 21,
      "unit_price": 1.5,
      "directions": "One capsule three times daily for seven days"
    }
  ],
  "notes": "OPD prescription from HMS"
}
```

This creates a pending pharmacy review record using HealthFlow's claim/prescription tables and returns a `reference` that the HMS can poll.

### Dispensing Status

```http
GET /hms-api/dispensing/{reference}
```

`reference` can be a HealthFlow sale number, claim/prescription number, or UUID. The response reports whether the record is still pending or has been dispensed as a sale.

## Recommended HMS Flow

1. Search medicines before prescribing so the doctor sees available pharmacy stock.
2. Upsert or include the patient when posting the prescription.
3. Store the returned `reference` in the HMS.
4. Poll `GET /hms-api/dispensing/{reference}` or call it when the patient returns from pharmacy.

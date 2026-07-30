# Platform Information Removal

Removed customer-facing platform-admin leakage:

| File | Original issue | Correction |
| --- | --- | --- |
| `docs/client-manual/NHIS-MCA-Claims-Officer-User-Manual.md` | Exposed "Super Admin" and "Tenant Admin" steps for assigning roles | Replaced with facility-admin workflow and HealthFlow support fallback |
| `docs/client-manual/NHIS-MCA-Claims-Officer-User-Manual.html` | Exposed "Super Admin setup" and "Tenant Admin" navigation | Replaced with facility-admin workflow and HealthFlow support fallback |

Search verification after correction:

The following terms were searched across the customer-facing source documents and returned no matches:

- `Platform Admin`
- `Admin Portal`
- `Super Admin`
- `Platform Owner`
- `Tenant Admin`
- `Switch portal`

Internal documents may still contain platform, deployment, database, or architecture language because they are not customer-facing deliverables.

# Screenshot Inventory

No standalone screenshot image files were found under `docs/` during this audit.

Image references found:

| Reference | Used by | Type | Status |
| --- | --- | --- | --- |
| `../../public/app-logo.png` | `docs/client-manual/HealthFlow-Client-User-Manual.html` | Product logo | Acceptable if logo is current |
| `../../public/app-logo.png` | `docs/client-manual/NHIS-MCA-Claims-Officer-User-Manual.html` | Product logo | Acceptable if logo is current |

Screenshot leakage result:

- No document screenshot assets containing Platform Admin, Supabase, Vercel, VS Code, browser tabs, terminals, real patient data, or live credentials were found in the `docs/` file tree.
- No PPTX/DOCX files were present to inspect hidden slides, comments, speaker notes, or embedded screenshots.
- PDF files were text-searched for prohibited Platform Admin terms, but should still be regenerated from corrected sources before distribution.

Future screenshot rule:

- Use only cropped, role-appropriate customer portal screenshots with fictional data.
- Do not use screenshots that show browser tabs, URLs with private IDs, developer tools, VS Code, terminal, Supabase, Vercel, or Platform Admin screens.

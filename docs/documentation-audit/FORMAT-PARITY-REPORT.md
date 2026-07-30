# Format Parity Report

Formats found:

- Markdown source
- HTML source/export
- PDF exports

Formats not found:

- DOCX
- PPTX / PowerPoint

Parity status:

| Deliverable family | Source status | Export status | Required action |
| --- | --- | --- | --- |
| Combined pharmacy/hospital pitch | Markdown and HTML corrected | No PDF/PPTX found | Use corrected source for any future export |
| Client-ready pitch deck | HTML corrected | No PDF/PPTX found | Use corrected source for any future export |
| Hospital pitch deck | HTML corrected | No PDF/PPTX found | Use corrected source for any future export |
| Pharmacy pitch deck | HTML corrected | No PDF/PPTX found | Use corrected source for any future export |
| HealthFlow client manual | HTML corrected | Existing PDF present | Regenerate PDF from corrected HTML |
| NHIS claims-officer manual | Markdown and HTML corrected | Existing PDF present | Regenerate PDF from corrected source |

PDF text search:

- `docs/client-manual/*.pdf` was searched for `Super Admin`, `Platform Admin`, and `Tenant Admin`.
- No matches were found.

Final parity note:

Because source documents changed during this audit, the PDF exports should be regenerated before external distribution even though the prohibited-term text search did not find a current platform-admin leak in the PDFs.

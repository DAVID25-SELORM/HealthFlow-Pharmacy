# Organization Provisioning Audit

## Production Flow

`tenantAdminService.createPharmacyTenant` calls the protected `tenant-signup`
Edge Function with the `create_tenant` action. The function authorizes a platform
Super Admin before provisioning tenant records.

Provisioning creates, in order:

1. Organization record.
2. One active main branch (`MAIN`).
3. Supabase Auth user for the first administrator.
4. Public user profile linked to the organization and main branch.
5. Organization owner link.
6. Facility settings.
7. Default medication catalogue.
8. Organization-level NHIA configuration.
9. `ORG-READY-001` readiness verification.

If any required step or readiness check fails, the function removes the newly
created Auth user and organization. Tenant-owned rows are removed through the
existing foreign-key cascade behavior.

## ORG-READY-001

The machine-verifiable readiness response contains:

- `contract`: `ORG-READY-001`
- `organizationId`
- `ready`
- `blockers`
- `warnings`

A tenant is blocked from successful provisioning when the organization is
missing or inactive, its owner/admin relationship is invalid, it does not have
exactly one active main branch, an administrator lacks a branch assignment,
facility settings are absent, or an NHIS-enabled tenant lacks NHIA configuration.

An empty medication catalogue is reported as a warning because catalogue content
can legitimately depend on the selected facility profile and later imports.

The readiness endpoint is restricted to platform Super Admins and can be used as
the configuration comparator for an existing tenant without exposing tenant data.

## Isolation And Compatibility

Provisioning creates defaults; it does not copy patients, claims, sales,
inventory quantities, attachments, credentials, audit records, or other tenant
transactions from an existing organization. The existing `public.users`
organization/branch assignment remains the membership model.

This change does not alter NHIS, CLAIM-it, Ghana Card/HIN, CCC, pricing, tariff,
claim, scrub, export, offline-sync, storage, or report behavior.

## Operational Verification

After creating a tenant, a platform administrator can call
`checkOrganizationReadiness(organizationId)`. A `ready: false` result must be
resolved before handing the tenant to facility staff.

Rollback is the ordinary application rollback: deploy the previous Edge Function
version. Existing organizations and branches must not be deleted as part of a
code rollback.

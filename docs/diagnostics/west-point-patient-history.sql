-- Read-only comparison for the two claims visible in patient history.
-- No clinical, identity, or access-control records are modified.
select claim_number, organization_id, branch_id, patient_id,
       surname, other_names, member_no, hin, folder_no,
       service_date_from, status
from public.nhis_claims
where claim_number in ('NHIS-009105', 'NHIS-009067')
order by organization_id, service_date_from, claim_number;

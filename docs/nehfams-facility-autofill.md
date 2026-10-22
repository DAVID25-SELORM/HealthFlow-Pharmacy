# Facility identity autofill

The administrator-only `discover_nehfams_facility` action reads the documented
facility-information endpoint using an explicit credential pair or this organization's
saved credentials. Saved production NHIA credentials are used only when no separate
NeHFAMS connection exists. Test credentials never fall back to production.

The response exposes only HPN and facility name. It neither saves configuration nor
validates the expected identity nor activates attendance. The administrator reviews
the returned identity before saving; existing connection validation still compares
NHIA identity with the saved expected identity. No attendance POST is issued.

UI responses are discarded when form details change during lookup. Tests cover
autofill without mutation, incomplete credentials, malformed and unsupported
responses, and stale lookup responses. The reviewed tier-access baseline change
adds this guarded read-only action; generation routing is unchanged.

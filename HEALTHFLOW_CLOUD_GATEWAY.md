# HealthFlow Cloud Gateway

Use a HealthFlow-owned gateway domain when you do not want pharmacy users to see the direct cloud provider host in browser network requests.

## Recommended production setup

1. Create a DNS name such as:

```text
api.healthflowcloud.com
```

2. Reverse-proxy these paths from that domain to the cloud project origin:

```text
/auth/v1/*
/rest/v1/*
/storage/v1/*
/functions/v1/*
/realtime/v1/*   # if realtime is enabled
```

3. Preserve these request headers:

```text
Authorization
apikey
Content-Type
Prefer
Range
X-Client-Info
```

4. Build the frontend with:

```text
VITE_HEALTHFLOW_CLOUD_URL=https://api.healthflowcloud.com
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

For a production build that fully hides the provider host from the browser bundle, do not set the raw provider URL in frontend variables. Keep provider origin details only in the gateway/proxy configuration.

## Fallback behavior

If `VITE_HEALTHFLOW_CLOUD_URL` is not configured, HealthFlow falls back to `VITE_SUPABASE_URL`. This is useful for local development and emergency troubleshooting, but it exposes the direct cloud project host to browser developer tools.

## Verification

After deployment, open browser developer tools and confirm HealthFlow requests go to:

```text
https://api.healthflowcloud.com/auth/v1/...
https://api.healthflowcloud.com/rest/v1/...
https://api.healthflowcloud.com/functions/v1/...
```

They should not go directly to the cloud provider project URL.

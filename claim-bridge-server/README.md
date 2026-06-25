# HealthFlow CLAIM-it Bridge

This is the production middleware for:

```text
https://claimbridge.healthflowgh.com/json-api
```

It is intentionally stateless. HealthFlow/Supabase calls this bridge, and the
bridge forwards to the official CLAIM-it/NHIA upstream.

## Required Environment

```env
CLAIM_BRIDGE_PUBLIC_PATH=/json-api
CLAIMIT_UPSTREAM_BASE_URL=https://official-claimit-or-nhia-host.example.com
CLAIM_BRIDGE_TOKEN=<long-random-production-token>
CLAIM_BRIDGE_TOKEN_HEADER=x-claim-bridge-token
ALLOWED_ORIGINS=https://healthflowcloud.com
```

Optional upstream auth:

```env
CLAIMIT_UPSTREAM_API_KEY=
CLAIMIT_UPSTREAM_API_KEY_HEADER=x-api-key
CLAIMIT_UPSTREAM_API_SECRET=
CLAIMIT_UPSTREAM_API_SECRET_HEADER=x-api-secret
CLAIMIT_UPSTREAM_BEARER_TOKEN=
CLAIMIT_UPSTREAM_USERNAME=
CLAIMIT_UPSTREAM_PASSWORD=
```

## Deploy

Render:

1. Create a new Web Service from this repository.
2. Set root directory to `claim-bridge-server`.
3. Use Docker deployment.
4. Set `CLAIMIT_UPSTREAM_BASE_URL`.
5. Let Render generate `CLAIM_BRIDGE_TOKEN`, or set your own secure token.
6. Add custom domain `claimbridge.healthflowgh.com`.

Any Docker host:

```bash
docker build -t healthflow-claim-bridge .
docker run -p 4780:4780 --env-file .env healthflow-claim-bridge
```

## DNS

Point:

```text
claimbridge.healthflowgh.com
```

to the deployed service using the CNAME/A record your host provides.

## Verify

```text
https://claimbridge.healthflowgh.com/json-api/health
```

Expected:

```json
{"ok":true,"mode":"healthflow-claim-bridge"}
```

## HealthFlow Settings

Use:

```text
Integration mode: CLAIM-it Local Bridge API
Connection profile: Production bridge server
Base URL: https://claimbridge.healthflowgh.com/json-api
Credential mode: API key
API key header: x-claim-bridge-token
API key: <CLAIM_BRIDGE_TOKEN>
```

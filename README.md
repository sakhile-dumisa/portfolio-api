# Contact Form API

A small Node.js + Express API for accepting contact form submissions, verifying senders with OTPs, and sending emails using Resend. Redis is used for OTP storage, cooldowns and verification state.

This README explains how to install, configure, run, and use the API (endpoints, request/response shapes and examples). It also covers security notes and deployment hints.

---

## Table of Contents
- [Contact Form API](#contact-form-api)
  - [Table of Contents](#table-of-contents)
  - [Features](#features)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Environment variables](#environment-variables)
  - [Start the server](#start-the-server)
  - [API endpoints](#api-endpoints)
  - [Examples](#examples)
    - [Request OTP (curl)](#request-otp-curl)
    - [Verify OTP (curl)](#verify-otp-curl)
    - [Send contact email (curl)](#send-contact-email-curl)
    - [Axios usage (client)](#axios-usage-client)
  - [Testing the flow](#testing-the-flow)
  - [Security notes](#security-notes)
  - [Deployment notes](#deployment-notes)
  - [Troubleshooting](#troubleshooting)
  - [Files of interest](#files-of-interest)

---

## Features
- Send OTP to verify user email addresses (6-digit codes)
- Store OTPs, cooldowns and verification state in Redis
- Send contact emails (text + HTML) with `reply_to` set to the user's email
- Send a thank-you email to the user after contact message is delivered
- Rate-limited and CORS-configured

## Prerequisites
- Node 18+ (recommended)
- Redis instance (recommended for production; optional for quick local testing)
- Resend account and API key (for sending emails)

## Install

Clone the repo and install dependencies:

```powershell
pnpm install
```

Dependencies used (high level): express, sanitize-html, resend, redis, cors, helmet, express-rate-limit, morgan, dotenv.

## Environment variables
Create a `.env` file in the project root (do NOT commit secrets). Example:

```env
# Server
PORT=3000

# Resend
RESEND_API_KEY=re_...your_resend_key_here

# Email senders (must be verified in Resend)
FROM_CONTACT=form@mail.sakhiledumisa.com
FROM_VERIFY=verify@mail.sakhiledumisa.com

# Redis (use Redis for OTP storage)
REDIS_HOST=redis-xxxx.example.com
REDIS_PORT=6379
REDIS_USERNAME=default
REDIS_PASSWORD=your_redis_password
# set REDIS_TLS=true if your provider requires TLS

# Simple API key to protect the send-email endpoint (optional but recommended)
X_API_KEY=your_secret_x_api_key_here

# Optional OTP settings (seconds)
OTP_TTL_SECONDS=600
OTP_COOLDOWN_SECONDS=60
MAX_VERIFY_ATTEMPTS=5
```

Notes:
- `RESEND_API_KEY` is required for email delivery. The app will exit if it's not set.
- Redis credentials must be valid for OTP/verification flows. If Redis is not configured the app provides a non-production fallback but verification endpoints will be limited.

## Start the server

```powershell
# local dev
pnpm start

# or with nodemon for development
# using pnpm to run the tool
pnpm exec nodemon server.js
```

The server hosts routes under `/email` so the endpoints are e.g. `http://localhost:3000/email/api/send-otp`.

## API endpoints

All endpoints expect `Content-Type: application/json`. If you configured `X_API_KEY` you must include the header `x-api-key: <value>` for endpoints that require it (for example the `send-email` endpoint).

- POST `/email/api/send-otp`
  - Body: `{ "email": "user@example.com" }`
  - Description: Request a 6-digit OTP to be sent to the email address.
  - Responses: 200 (OTP sent), 400 (invalid email), 429 (cooldown)

- POST `/email/api/verify-otp`
  - Body: `{ "email": "user@example.com", "code": "123456" }`
  - Description: Verify the OTP code; on success the email is marked verified in Redis.
  - Responses: 200 (verified), 400 (invalid/expired), 429 (too many attempts)

- POST `/email/api/send-email`
  - Body: `{ "to": "form@mail.sakhiledumisa.com", "userName": "Alice", "sentBy": "user@example.com", "message": "Hello" }`
  - Description: Sends a contact message (requires `sentBy` to be verified via OTP). The server will send the message to `to`, then send a thank-you email to `sentBy`.
  - Headers: `x-api-key: <your X_API_KEY>` if set in env
  - Responses: 200 (sent), 400 (validation), 401 (invalid api key), 403 (unverified), 500 (server error)

## Examples

### Request OTP (curl)
```bash
curl -X POST "http://localhost:3000/email/api/send-otp" \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com"}'
```

### Verify OTP (curl)
```bash
curl -X POST "http://localhost:3000/email/api/verify-otp" \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@example.com","code":"123456"}'
```

### Send contact email (curl)
```bash
curl -X POST "http://localhost:3000/email/api/send-email" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $X_API_KEY" \
  -d '{"to":"form@mail.sakhiledumisa.com","userName":"Alice","sentBy":"alice@example.com","message":"Hello!"}'
```

### Axios usage (client)
Use your own proxy if calling from a browser; do not embed `X_API_KEY` in public SPA bundles.

```javascript
import axios from 'axios';
const api = axios.create({ baseURL: 'https://mail.sakhiledumisa.com/email/api' });
api.defaults.headers['x-api-key'] = process.env.X_API_KEY; // server-side or trusted client only

await api.post('/send-otp', { email: 'alice@example.com' });
await api.post('/verify-otp', { email: 'alice@example.com', code: '123456' });
await api.post('/send-email', { to: 'form@mail.sakhiledumisa.com', userName: 'Alice', sentBy: 'alice@example.com', message: 'Hi' });
```

## Testing the flow
1. POST to `/email/api/send-otp` with the user's email.
2. Check the inbox and copy the 6-digit code.
3. POST to `/email/api/verify-otp` with the code.
4. POST to `/email/api/send-email` (same `sentBy` as verified) to send the contact message.

Client UI suggestions:
- Disable the "resend" button for 60s after requesting OTP and show a countdown.
- Limit verify attempts (server enforces 5 attempts).
- Show clear error messages for 400/401/403/429 return codes.

## Security notes
- Keep `RESEND_API_KEY`, `REDIS_PASSWORD`, and `X_API_KEY` in your host's secret store — do not commit `.env` to git.
- Do not embed `X_API_KEY` in public browser JavaScript. Instead, implement a small server-side proxy that injects the `x-api-key` header and forwards requests to the mail API.
- Use TLS for Redis connections (set `REDIS_TLS=true`) if available and use a managed Redis provider for production.

## Deployment notes
- If using Vercel, ensure you set the environment variables in the Vercel dashboard and add any necessary Redis networking configuration.
- Keep the `FROM_*` addresses verified in Resend and update DNS (SPF/DKIM) for best deliverability.

## Troubleshooting
- `RESEND_API_KEY is not set`: set `RESEND_API_KEY` in `.env` or host secrets.
- Redis connection errors: confirm host/port/username/password and network access.
- If OTP emails don't arrive: check spam folder and verify `FROM_VERIFY` is a verified Resend sender.

## Files of interest
- `server.js` — app initialization, middleware, Redis init
- `routes/emailRoute.js` — OTP and email sending logic, templates
- `.env` — environment variables (example values in repo)


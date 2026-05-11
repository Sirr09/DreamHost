# DreamHost deploy

This project is now a single deployable Node/React app. The React build is emitted into `server/public`, and Express serves both `/api/*` and the frontend routes.

## Local production build

```bash
cd client
npm install
npm run build

cd ../server
npm install
cp .env.example .env
npm run seed
npm start
```

Open `http://localhost:5000` unless you changed `PORT`.

## Default admin

The seed script creates an admin account from `.env`.

```text
ADMIN_EMAIL=admin@dreamhost.az
ADMIN_PASSWORD=DreamHost@2026!
```

Change `ADMIN_PASSWORD` and `JWT_SECRET` before putting the site online, then run:

```bash
npm run seed
```

## AI support bot

The chat widget calls `POST /api/support/chat`. The browser never sees the Gemini key; Express reads it from `.env`.

```text
GEMINI_API_KEY=your-google-ai-studio-api-key
GEMINI_MODEL=gemini-3-flash-preview
GEMINI_FALLBACK_MODEL=gemini-2.5-flash
```

If Gemini 3 Flash is unavailable for the key or API version, the server can fall back to the configured fallback model so support chat still answers.

## DreamHost VPS / Dedicated

DreamHost's current Node.js documentation says Node apps are available on VPS and Dedicated servers. Their proxy documentation says the app should listen on a non-privileged port in the `8000-65535` range, then the DreamHost panel proxy maps the public domain to that port.

Recommended setup:

```bash
cd ~/dreamhost-server/server
cp .env.example .env
npm install --omit=dev
npm run seed
npm start
```

In DreamHost Panel, create a Proxy Server for your domain and set the proxy port to the same `PORT` value in `.env`, for example `8002`.

Official references:

- https://help.dreamhost.com/hc/en-us/articles/217185397-Node-js-overview
- https://help.dreamhost.com/hc/en-us/articles/217955787-Proxy-Server

## Domain candidates

`dreamhost.com` belongs to DreamHost, so do not use a confusingly identical brand for a public business. Safer candidates to check in the DreamHost domain panel:

- `dreamhostazerbaijan.com`
- `dreamhostservers.com`
- `dreamhostcloud.net`
- `dreamhostpro.net`
- `dreamhostaz.com`

Always confirm availability in the registrar panel before buying.

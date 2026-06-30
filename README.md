# 👻 PhantomDial — Setup Guide

A simultaneous ring-group system with listen-in capability. Incoming callers only see your Twilio number — your real identity stays hidden.

---

## How it works

1. Someone calls your **Twilio number**
2. PhantomDial instantly rings **all your configured numbers at once** (up to 10)
3. **First person to pick up** gets connected — all others are automatically dropped
4. You can tap **Listen In** on the dashboard to silently join any live call
5. The original caller never sees your real numbers

---

## Step 1 — Get a Twilio account

1. Sign up at https://www.twilio.com (free trial gives ~$15 credit)
2. Buy a phone number (~$1/month for a UK number)
3. Copy your **Account SID** and **Auth Token** from the console

> **Cost estimate:** ~£1/month for the number + ~1–2p/minute per call leg. For 6 outbound legs ringing simultaneously, budget ~10–12p/min while ringing.

---

## Step 2 — Deploy to Railway (free tier)

1. Create a free account at https://railway.app
2. Click **New Project → Deploy from GitHub repo**
3. Upload or push this folder to a GitHub repo first, then connect it
4. Set these **environment variables** in Railway's dashboard:

```
TWILIO_ACCOUNT_SID   = ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN    = your_auth_token
TWILIO_NUMBER        = +14155552671          ← your Twilio number
RING_TARGETS         = +447911111111,+447922222222,+447933333333
LISTEN_NUMBER        = +447900000000         ← YOUR personal number for listen-in
BASE_URL             = https://your-app.railway.app   ← Railway gives you this
DASHBOARD_PASS       = choose-a-strong-password
PORT                 = 3000
```

5. Railway will deploy automatically. Note your app URL.

---

## Step 3 — Point Twilio at your app

1. Go to **Twilio Console → Phone Numbers → Manage → Active numbers**
2. Click your number
3. Under **Voice & Fax → A call comes in**, set:
   - **Webhook:** `https://your-app.railway.app/incoming`
   - **HTTP Method:** POST
4. Save

---

## Step 4 — Use the dashboard

Open `https://your-app.railway.app` on your phone.

- Enter your `DASHBOARD_PASS` to unlock
- **Active Calls** shows all live/ringing calls (auto-refreshes every 5s)
- Tap **👂 Listen In** → PhantomDial calls YOUR number and connects you silently to the live conference
- Tap **📵 End Call** to terminate a call remotely
- Numbers are partially masked on screen for privacy

---

## Webhook URLs (for reference)

| Purpose              | URL                              |
|----------------------|----------------------------------|
| Incoming call        | `POST /incoming`                 |
| Outbound answer      | `POST /outbound-answer`          |
| Outbound status      | `POST /outbound-status`          |
| Listen-in join       | `POST /listen-join`              |
| Dashboard API        | `GET  /api/calls`                |
| Config API           | `GET  /api/config`               |

---

## Updating ring targets

Edit the `RING_TARGETS` environment variable in Railway (comma-separated E.164 numbers) and redeploy. No code changes needed.

---

## Security notes

- The dashboard is password-protected — choose a strong `DASHBOARD_PASS`
- All phone numbers are partially masked in the UI
- Your personal `LISTEN_NUMBER` is never displayed on screen
- HTTPS is handled automatically by Railway

---

## Running locally (optional)

```bash
cp .env.example .env
# fill in .env values
npm install
npm start
# Use ngrok to expose locally: ngrok http 3000
# Set BASE_URL to your ngrok URL
```

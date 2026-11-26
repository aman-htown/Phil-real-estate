# Connecting a live WhatsApp account

There are two ways to connect. **For groups created by other people (and messages you type on your phone, and chat history) you need Option A.** Option B, the official API with an API key, can't see those groups.

| | **A. Link your phone (QR code)** | **B. Official Cloud API (API key)** |
|---|---|---|
| Needs an API key | No | Yes (access token from Meta) |
| Reads groups other people created | **Yes** | No |
| Sees messages you type on your phone | Yes | No |
| Imports past chat history | Yes | No |
| Your number keeps working in the WhatsApp app | Yes | Usually no (the number moves to the API) |
| Needs a public web address | No | Yes (for Meta's webhook) |
| Officially supported by Meta | No: automated use can get a number banned | Yes |
| Time to set up | 5 minutes | 30-60 minutes, plus Meta business verification for higher limits |

---

## Option A: link your phone with a QR code (recommended for your use)

No API key. The worker becomes a "linked device" on your WhatsApp, like WhatsApp Web on a computer.

1. In your `.env` file, set:
   ```
   WHATSAPP_TRANSPORT=web
   ```
2. Restart the worker. Stop it with Ctrl+C, then run:
   ```bash
   npm run dev:worker
   ```
3. Open the inbox at http://localhost:3000 and go to **Status**. A QR code appears within a few seconds. It's also printed in the worker's terminal.
4. On your phone, open WhatsApp → **Settings** (iPhone) or **⋮ menu** (Android) → **Linked devices** → **Link a device**, and scan the code.
5. The Status page shows **WhatsApp connected**. Your chat history starts importing, and your groups appear on the **Groups** page.

Before you link, decide how bold Claude should be:
- **Settings → New groups: assistant**: start with **Draft**, so you approve every private reply until you trust it. Switch to **Auto** when you're ready.
- **Settings → Allow automatic sending**: the master off-switch for all automatic replies.

Good to know:
- The link survives restarts and redeploys (it's stored in the database). If you unlink the device from your phone, a new QR code appears on the Status page.
- Your phone needs to be online now and then (at least every ~14 days) or WhatsApp unlinks the device.
- Run **one** worker per WhatsApp account. Two workers will knock each other off.
- To keep it running when your computer is off, deploy the worker to a server (Render, using `render.yaml`) and link again from the deployed Status page.
- **Ban risk:** WhatsApp doesn't allow unofficial automation. Messaging many people who never wrote to you (for example, auto-DMing everyone in a big group) is what gets numbers banned. Keep replies relevant and volumes modest, and consider a separate business number.

---

## Option B: the official WhatsApp Cloud API (getting an API key)

Use this for a dedicated business number that only needs 1:1 chats with customers who message you. Meta's menus change names from time to time; the steps below match the usual flow.

### 1. Create a Meta developer app
1. Go to **developers.facebook.com** and log in with a Facebook account. Click **My Apps → Create App**.
2. When asked what the app is for, choose the **WhatsApp / "Connect with customers through WhatsApp"** option (or "Other" → app type **Business**).
3. Connect it to a **Meta Business portfolio** (business.facebook.com). Create one if you don't have one.

### 2. Get a test API key and number (works in minutes)
1. In the app dashboard, open **WhatsApp → API Setup**.
2. You'll see:
   - a **temporary access token**. This is your API key, but it **expires after 24 hours**;
   - a free **test phone number** and its **Phone number ID**;
   - a **To** field: add your own phone as an allowed recipient and confirm the code WhatsApp sends you.

### 3. Get a permanent API key
1. Go to **business.facebook.com → Settings → Users → System users → Add**. Create an **Admin** system user.
2. Click **Assign assets**, pick your app, and give it full control.
3. Click **Generate new token**, select your app, and tick:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
4. Copy the token. This is your permanent **WHATSAPP_ACCESS_TOKEN**. Store it like a password; Meta won't show it again.

### 4. Use your real business number (when ready)
1. In **WhatsApp → API Setup**, click **Add phone number**. Enter the display name and number, and verify by SMS or voice call.
2. The number must not be active in the WhatsApp app at the same time, so register it with the API first. Meta also offers a "coexistence" setup that lets a WhatsApp Business **app** number keep working on the phone; check whether it's offered for your account.
3. Copy the new number's **Phone number ID**.
4. Add a payment method and complete **business verification** in Business Settings for higher sending limits.

### 5. Find your app secret
**App settings → Basic → App secret** → Show. This is **WHATSAPP_APP_SECRET**, used to check that webhooks really come from Meta.

### 6. Fill in `.env`
```
WHATSAPP_TRANSPORT=cloud
WHATSAPP_ACCESS_TOKEN=<token from step 3 (or the 24h test token)>
WHATSAPP_PHONE_NUMBER_ID=<Phone number ID from step 2 or 4>
WHATSAPP_VERIFY_TOKEN=<any word you make up, e.g. elm-street-2026>
WHATSAPP_APP_SECRET=<from step 5>
```
Restart the worker.

### 7. Point Meta's webhook at the worker
Meta has to reach the worker over the internet, at a **public HTTPS address**.
- **Deployed** (e.g. on Render): the address is `https://<your-worker>.onrender.com/webhooks/whatsapp`.
- **On your computer:** use a tunnel, for example `npx cloudflared tunnel --url http://localhost:8080` or ngrok. Use the `https://…` address it prints plus `/webhooks/whatsapp`.

Then in the app dashboard go to **WhatsApp → Configuration → Webhook → Edit**:
1. **Callback URL**: the address above.
2. **Verify token**: the same word as `WHATSAPP_VERIFY_TOKEN`.
3. Click **Verify and save**, then under **Webhook fields** click **Subscribe** next to **messages**.

### 8. Test
Send a WhatsApp message to the business (or test) number from your phone. It appears in the inbox within a second or two, and Claude drafts a reply.

Cloud API rules to know:
- You can only send free-form replies within **24 hours** of the customer's last message. After that, WhatsApp requires an approved **template** message (the inbox warns you).
- The Cloud API can't read or post in groups that other people created.

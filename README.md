# WhatsApp inbox assistant

An always-on service that watches a WhatsApp inbox and answers each conversation with Claude, plus a web inbox (deployed on Vercel) where the team can read every conversation, edit and approve AI drafts, reply by hand, and control how much the assistant does on its own.

```
                 WhatsApp
                    │  ▲
   webhook / socket │  │ send
                    ▼  │
┌──────────────────────────────────┐        ┌──────────────────────────────┐
│ apps/worker  (always on)         │        │ apps/web  (Vercel)           │
│                                  │        │                              │
│  transport ─► ingest             │        │  Inbox · Drafts · Composer   │
│               │ pending_reply_at │        │  Knowledge base · Settings   │
│  responder ◄──┘  (debounced)     │        │  Status (QR pairing, stats)  │
│     │  Claude (structured output)│        │                              │
│     ▼                            │        │  approve / edit / send ──┐   │
│  draft ─► auto-send? ─► outbox ──┼─ send  │                          │   │
└──────────────┬───────────────────┘        └──────────────┬───────────┼───┘
               │                 Postgres                  │           │
               └───────────────► (shared) ◄────────────────┘ ◄─────────┘
```

The two apps never call each other. They coordinate through Postgres. Inbound messages set a "reply due" time on the conversation, and the worker's responder picks it up. Anything to be sent (auto replies, approved drafts, hand-written replies) goes into an outbox, and the worker sends it. So the UI runs fine on serverless, and the worker is the only process that talks to WhatsApp.

## How a message flows

1. **Ingest.** A contact writes, and the transport hands the message to `ingestInbound`, which stores it (idempotent on WhatsApp's message id) and sets `pending_reply_at = now + debounce`. If the contact sends three messages in a row, they get one reply.
2. **Respond.** The worker claims due conversations (`FOR UPDATE SKIP LOCKED`) and builds context: your instructions, the knowledge base, the last N messages, team notes on the contact, and the current time. Claude returns structured output: `action` (`reply` / `no_reply` / `escalate`), the reply text, a note for the team, intent, urgency, and an updated summary.
3. **Decide.** What happens next depends on the conversation's **mode**:
   - **Auto**: replies are queued and sent. Escalations are never auto-sent; they become drafts and flag the conversation.
   - **Draft**: the reply waits in the UI for someone to edit, send, regenerate, or discard.
   - **Off**: no AI.
   Each conversation can override the default mode, and a global switch in Settings turns all auto-sending into drafts.
4. **Send.** The outbox sends queued messages, marks the contact's message read, and tracks delivery receipts (sent → delivered → read, or failed with WhatsApp's reason and a Retry button).

Safety rails:
- If the contact writes again while Claude is thinking, or a human replies first, the stale draft is superseded instead of sent.
- If someone replies from the phone (WhatsApp Web transport), the pending AI reply is cancelled.
- Claude errors and policy refusals become visible error drafts and flag the conversation. Refusals first retry on Anthropic's fallback model (`fallbacks: "default"`).

## Groups and private replies

With the WhatsApp Web transport, every group the account is in is listed on the **Groups** page.

- **Tracking.** Groups the account joins after linking are tracked automatically (Settings). Groups it was already in start untracked, so family chats don't flow in. Messages from untracked groups are never stored.
- **Private replies (default for new groups).** When a member writes in a tracked group, Claude opens a 1:1 chat with that member and replies there, about 5 seconds later, with the group's recent messages as context. It only follows up when the message warrants it (a question, interest, a request), and it won't re-message someone it already answered. Each group's header switches between "privately to each sender" and "in the group", and Auto / Draft / Off.
- **Reading and replying.** Group messages show who wrote them. Reply to the group from the composer, or click **Message privately** on any message or member.
- **@mentions** of the business flag the group for attention.

## The complete record

- Messages typed on the phone are recorded, and they cancel any pending AI reply.
- Chat history is imported when the phone is linked (`WEB_HISTORY=full|recent|none`). It's stored for the record and never replied to.
- Messages that arrive after downtime are stored, but not answered if they're older than `WEB_MAX_BACKLOG_HOURS`.
- **Not a customer.** For a personal chat, use the contact panel's stop-tracking action. It deletes that chat's stored messages and ignores new ones. Restore it from the Groups page.

## Repository layout

```
packages/core     Postgres schema (Drizzle), migrations, and the domain operations both apps use
apps/worker       Always-on Node service: WhatsApp transports, Claude responder, outbox, /health
  src/transports    cloud.ts (Meta Cloud API), web.ts (WhatsApp Web via Baileys), mock.ts (dev)
  src/ai            prompt.ts (context building), claude.ts (API call + output schema)
  src/pipeline      responder.ts, outbox.ts
apps/web          Next.js inbox UI for Vercel (API routes + React client)
render.yaml       One-click deploy of the worker to Render
```

## Run it locally

Requires Node 20.11+ and Postgres.

```bash
npm install
```

Fill in `env-template.txt` (each setting is explained inside) and save it as `.env` in the repo root:

```bash
cp env-template.txt .env
```

```bash
docker compose up -d    # local Postgres (or point DATABASE_URL at any Postgres)
```

```bash
npm run db:migrate
```

Then run each of these in its own terminal:

```bash
npm run dev:worker
```

```bash
npm run dev:web
```

Open http://localhost:3000, sign in with `ADMIN_PASSWORD`, go to **Status**, and use **Simulate an inbound message**. With `WHATSAPP_TRANSPORT=mock`, nothing touches WhatsApp: replies are logged by the worker and receipts are faked.

## Choosing a WhatsApp transport

Step-by-step instructions for linking a live WhatsApp account, or getting an official Cloud API key, are in [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md).

| | `cloud`: WhatsApp Business Cloud API | `web`: WhatsApp Web (Baileys) |
|---|---|---|
| What it connects to | A business phone number registered with Meta | Any existing WhatsApp / WhatsApp Business app account, as a linked device |
| Setup | Meta developer app, number, access token, webhook | Scan a QR code on the Status page |
| Official / ToS-safe | Yes | No. Unofficial client; automated use risks a ban |
| Sees replies typed on the phone | No | Yes, and they cancel pending AI replies |
| 24-hour rule | Free-form replies only within 24h of the contact's last message (the UI warns) | No template rule |
| Needs a public URL | Yes (webhook) | No |

Use **web** for groups, phone-typed messages, and history. The Cloud API can't read groups created by other people. Use **cloud** only for a dedicated business line that needs none of those.

**Cloud API setup:** in developers.facebook.com, create an app with the WhatsApp product. Note the *Phone number ID* and create a permanent access token (System User). Under *Configuration*, set the callback URL to `https://<worker-host>/webhooks/whatsapp`, set the verify token to your `WHATSAPP_VERIFY_TOKEN`, and subscribe to **messages**. Set `WHATSAPP_APP_SECRET` so webhook signatures are verified.

**WhatsApp Web setup:** set `WHATSAPP_TRANSPORT=web` and start the worker. On the web UI's Status page, scan the QR code from the phone (WhatsApp → Linked devices → Link a device). The session is stored in Postgres (`wa_auth_state`), so it survives redeploys. Run exactly one worker per account.

## Deploy

**1. Postgres.** Any managed Postgres works (Neon, Supabase, Render). Vercel's serverless functions need a pooled connection string. The worker can use a direct one. Migrations run on worker start when `RUN_MIGRATIONS=true`, or run `npm run db:migrate` against the production URL.

**2. Worker (always on).** It must run continuously, so not on Vercel.
- **Render:** New → Blueprint → this repo. `render.yaml` sets up a Docker service with a health check. Fill in `DATABASE_URL`, `ANTHROPIC_API_KEY` and the WhatsApp variables.
- **Anywhere else** (Fly.io, Railway, a VM): `docker build -f apps/worker/Dockerfile .` from the repo root, expose port 8080, run one instance.

**3. Web UI (Vercel).** Import the repo in Vercel and set **Root Directory** to `apps/web`; the framework preset (Next.js) and build settings auto-detect. Add the environment variables `DATABASE_URL` (pooled), `ADMIN_PASSWORD`, and `AUTH_SECRET` (`openssl rand -base64 32`). Deploy. The Status page should show the worker's heartbeat within 15 seconds.

## Configuration

Runtime behaviour lives in the **Settings** page (stored in Postgres, applied on the next reply):

| Setting | Default | Notes |
|---|---|---|
| Allow automatic sending | on | Master switch. Off = auto mode drafts instead of sending |
| Default mode | `draft` | Start with drafts, review a few days of output, then switch to auto |
| Wait before replying | 20 s | Debounce for contacts who send several short messages |
| Messages of history | 40 | How much of the conversation Claude reads |
| Time zone | UTC | Used for timestamps Claude sees ("tomorrow", business hours) |
| Instructions | real-estate starter prompt | Persona, tone, what to offer, what never to promise |
| Model / effort | Claude Opus 5.5 / `medium` | Raise effort for trickier conversations; Sonnet or Haiku for cost |

The **Knowledge base** holds facts: listings, fees, process, areas, FAQs. Every enabled entry goes to Claude with each reply (the page shows the token cost). Claude is told not to state facts that aren't there and to escalate instead.

Fixed rules (output semantics, prompt-injection handling, no invented facts) live in `apps/worker/src/ai/prompt.ts` (`CORE_INSTRUCTIONS`). The output schema is in `apps/worker/src/ai/claude.ts`.

Environment variables are documented in `.env.example`.

## Extending

- **Media.** Inbound media is stored as `[image]` / `[voice note]` plus caption, with the media id in `messages.meta`. To let Claude see images or transcribe voice notes, download the media in the transport and pass it as an image or document block in `prompt.ts`.
- **Tools.** For live data (a listings search, calendar availability for viewings), add Claude tool use in `claude.ts`. The current design is one structured call per turn.
- **Templates.** Cloud API messages outside the 24h window need approved templates. Add a `sendTemplate` method to `CloudTransport` and a template picker in the composer.
- **Per-user accounts.** `apps/web/src/lib/auth.ts` is a shared-password scheme with named sessions. Swap in Auth.js or Clerk if you need individual logins and audit trails.
- **More numbers.** Contacts are keyed by the transport's address. For several business numbers, add a `channel` column to conversations and run a worker per number.

## Development notes

- `npm run typecheck` checks all workspaces. `npm run build:web` runs the Vercel build locally.
- After changing `packages/core/src/schema.ts`, run `npm run db:generate` to create a migration in `packages/core/drizzle/`, and commit it.
- Without WhatsApp credentials, `WHATSAPP_TRANSPORT=mock` plus the Status-page simulator exercises the whole pipeline: debounce, Claude, drafts, approval, outbox, receipts.

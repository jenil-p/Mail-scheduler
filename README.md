# 🚀 Sendly — Email Job Scheduler

A production-grade email scheduling service. Schedule emails, manage queues with BullMQ + Redis, and monitor everything from a modern dashboard — all while surviving server restarts.

---

## 🧪 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 14, TypeScript, Tailwind CSS |
| **Backend** | Express.js, TypeScript, Prisma 7 |
| **Queue** | BullMQ (Redis-backed) |
| **Database** | PostgreSQL 16 |
| **SMTP** | Ethereal Email (test accounts, no real emails) |
| **Auth** | Google OAuth 2.0 |
| **Infra** | Docker Compose |

---

## ✨ Features

- **Email Scheduling** — staggered sends per recipient with configurable delay
- **Sliding Window Log Rate Limiting** — per-sender hourly limit via Redis sorted sets (accurate, no boundary artefacts)
- **Persistence on Restart** — BullMQ + Redis AOF survives crashes without losing jobs
- **Idempotency** — duplicate sends are prevented via status checks
- **Dashboard** — stats cards, tabbed job views, auto-refresh
- **Compose Modal** — recipient management with CSV/text upload + manual entry
- **Google Sign-In** — popup-based OAuth 2.0 flow

---

## 🏗 Architecture

```
Next.js UI ──▶ Express API ──▶ BullMQ Queue ──▶ BullMQ Worker
                     │                                │
                     ▼                                ▼
                PostgreSQL                       Ethereal Email
```

1. User schedules emails → POST /api/schedule
2. Backend creates DB records + BullMQ delayed jobs
3. Worker picks up jobs at scheduled time → checks idempotency → checks rate limit → sends via Ethereal
4. Status updated in PostgreSQL → frontend polls/refreshes

---

## 🚀 Getting Started

### Prerequisites

- Docker & Docker Compose
- Google OAuth credentials (for sign-in)

### 1. Configure Environment

Copy the example env files and fill in your credentials:

```bash
cp .env.example .env                          # frontend build-time values (Google client ID)
cp backend/.env.example backend/.env          # backend secrets (Google OAuth, JWT)
```

Then edit each file:

- **`.env`** (root) — docker compose reads this automatically for the frontend's build-time `NEXT_PUBLIC_*` values: `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (required) and optionally `NEXT_PUBLIC_API_URL`.
- **`backend/.env`** — Google OAuth `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `JWT_SECRET`. `DATABASE_URL`, `REDIS_HOST`, `PORT` and `NODE_ENV` are overridden by docker-compose.yml — no need to touch them.

### 2. Run the whole stack

```bash
docker compose up --build -d
```

This builds the backend and frontend images, starts PostgreSQL + Redis, applies database migrations automatically (via the backend's entrypoint), and starts the API server + BullMQ worker + Next.js dashboard.

Visit http://localhost:3000 and sign in with Google.

| Service   | URL                          |
|-----------|------------------------------|
| Frontend  | http://localhost:3000        |
| Backend   | http://localhost:4000        |
| PostgreSQL| localhost:5432 (sendly/sendly_pass) |
| Redis     | localhost:6379               |

Useful commands:

```bash
docker compose logs -f backend   # watch API/worker logs
docker compose down              # stop (data persists in volumes)
docker compose down -v           # stop and wipe database + redis
```

### Run without Docker (local development)

If you prefer to run the services directly on Node.js 20+:

```bash
cp frontend/.env.example frontend/.env.local

# Terminal 1 — infrastructure
docker compose up -d postgres redis

# Terminal 2 — backend
cd backend && npm install && npx prisma generate && npm run dev

# Terminal 3 — frontend
cd frontend && npm install && npm run dev
```

### Google OAuth Setup

1. Go to Google Cloud Console
2. Create a project → enable OAuth consent screen
3. Create an OAuth 2.0 Client ID (Web application)
4. Add http://localhost:3000 as authorized JavaScript origin
5. Add http://localhost:4000/api/auth/google/callback as redirect URI
6. Put the Client ID in **both** the root `.env` (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`) and `backend/.env` (`GOOGLE_CLIENT_ID`); Client Secret in `backend/.env`

These URLs match the docker-compose port mappings (3000/4000), so they work for both Docker and local development.

---

## 📡 API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /api/health | No | Health check |
| POST | /api/auth/google | No | Exchange Google token for JWT |
| GET | /api/auth/me | Yes | Current user info |
| POST | /api/schedule | Yes | Schedule emails |
| GET | /api/jobs | Yes | List jobs (paginated, filterable) |
| GET | /api/jobs/stats | Yes | Dashboard stats |

### Schedule Emails

```json
POST /api/schedule
{
  "recipients": ["a@example.com", "b@example.com"],
  "subject": "Hello",
  "body": "<p>Hi there</p>",
  "senderEmail": "you@example.com",
  "scheduledAt": "2025-01-15T10:00:00.000Z",
  "delayBetweenEmails": 2000
}
```

### Dashboard Stats Response

```json
{ "pending": 10, "sent": 50, "failed": 2, "rateLimited": 3, "total": 65 }
```

---

## ⚡ Rate Limiting

Uses a **sliding window log** — the most accurate rate limiting approach:

- Every send is stored as a timestamped member in a Redis sorted set, keyed by sender email
- On each check, entries older than 1 hour are trimmed and the remaining count is compared against MAX_EMAILS_PER_HOUR (default 200)
- The trim + count + add runs as a single atomic Lua script — no race conditions
- Rate-limited jobs are rescheduled after the window rolls over (with jitter to avoid thundering herd)

| Variable | Default | Description |
|----------|---------|-------------|
| MAX_EMAILS_PER_HOUR | 200 | Per-sender hourly limit |
| MIN_DELAY_MS | 2000 | Minimum delay between sends |
| WORKER_CONCURRENCY | 5 | Parallel worker processes |

---

## 💡 Why These Choices

| Decision | Reason |
|----------|--------|
| BullMQ over cron | Native delayed jobs, survives restarts, built-in retry/backoff |
| Sliding window log over fixed/rolling window | No boundary artefacts — always measures exact count in trailing window |
| PostgreSQL + Prisma | Type-safe queries, migrations, relational data fits job status tracking |
| Redis for rate limiting | Atomic operations, shared across workers, ~1ms latency |
| Ethereal for SMTP | Fake emails for testing — zero setup, preview URLs in console |

---

## 📁 Project Structure

```
sendly/
├── backend/
│   ├── Dockerfile           # multi-stage build (prisma generate + tsc)
│   ├── docker-entrypoint.sh # prisma migrate deploy -> node dist
│   ├── .dockerignore
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/      # committed, applied automatically in Docker
│   ├── prisma.config.ts
│   ├── src/
│   │   ├── config/index.ts
│   │   ├── db/pool.ts
│   │   ├── email/           # transporter + sender
│   │   ├── middleware/      # auth, errorHandler, validate
│   │   ├── queue/           # BullMQ queue, worker, rateLimiter
│   │   ├── routes/          # auth, schedule, jobs
│   │   ├── types/index.ts
│   │   └── index.ts
│   └── .env.example
│
├── frontend/
│   ├── Dockerfile           # multi-stage build (next build)
│   ├── .dockerignore
│   ├── src/
│   │   ├── app/             # layout, page, globals.css
│   │   ├── components/      # pages, ui/, ComposeModal, Header
│   │   ├── hooks/           # useAuth, useJobs
│   │   ├── lib/api.ts
│   │   └── types/index.ts
│   └── .env.example
│
├── docker-compose.yml       # postgres + redis + backend + frontend
├── .env.example             # frontend build-time values (read by compose)
└── README.md
```

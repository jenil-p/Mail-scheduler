# Sendly — Distributed Email Scheduler & Personalization Engine

Sendly is a crash-resilient email scheduling and campaign dispatch platform built with Next.js, Express, BullMQ, Redis, and PostgreSQL.

---

## What It Solves

### 1. Robust Rate Limiting & Queue Reliability
- **Zero Boundary Bursts:** Standard fixed-window limits allow double-rate spikes at window boundaries, triggering SMTP spam blacklists. Sendly enforces an atomic **Sliding Window Log rate limiter** in Redis (via Lua script) to guarantee strict rolling per-hour limits across all concurrent workers.
- **Dynamic Rescheduling:** Throttled jobs are never dropped. The system computes the exact millisecond the sender's window clears and reschedules the job with randomized jitter to prevent thundering herd problems.
- **Crash Persistence & Idempotency:** Backed by BullMQ and Redis persistence, scheduled jobs survive server restarts and network partitions. Database-level state checks guarantee zero duplicate sends.

### 2. Guardrailed AI Email Personalization
- **Context-Aware Outreach:** Generates personalized intro lines for recipients from campaign context rather than sending generic blast templates.
- **Automated Guardrails:** Pre-send validation filters prevent prompt injections, hallucinated entities, banned keywords, and formatting defects.
- **Fault-Tolerant Quota Handling:** Distinguishes transient provider rate limits (retried with exponential backoff) from quota exhaustion (instant, graceful fallback to default templates so campaigns continue uninterrupted).
- **Prompt Fingerprinting:** Freezes prompt templates per campaign, guaranteeing consistent generation across distributed worker nodes.

---

## Quickstart

### 1. Setup Environment
```cmd
copy .env.example .env
copy backend\.env.example backend\.env
```
> Add your Google OAuth credentials in `.env` and `backend\.env`.

### 2. Build & Run
```cmd
docker compose up --build -d
```

### 3. Open Application
- **Frontend Dashboard:** http://localhost:3000
- **Backend API:** http://localhost:4000

To view logs or stop the containers:
```cmd
docker compose logs -f backend
docker compose down
```

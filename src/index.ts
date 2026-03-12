// Voice Gateway — entry point for all Hume requests
//
// Responsibilities:
//   1. Accept POST /chat/completions from Hume
//   2. Validate request
//   3. Create/resolve session ID (never shared between kiosks)
//   4. Log session lifecycle
//   5. Enforce request timeout
//   6. Stream response back to Hume
//   7. Handle errors gracefully — never leave Hume hanging

import dotenv from 'dotenv';
import path from 'path';
import { randomUUID } from 'crypto';

// __dirname is dist/ after compile — .env is one level up at project root
const dotenvResult = dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
if (dotenvResult.error) console.error('[gateway] dotenv load error:', dotenvResult.error);

console.log(
  '[gateway] ENV check — DATABASE_URL:', !!process.env.DATABASE_URL,
  '| OPENAI:', !!(process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY),
  '| REDIS:', !!process.env.REDIS_URL
);

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { pool } from './db';
import { getCache } from './cache';
import { askQuestion, askQuestionStreaming } from './rag';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const REQUEST_TIMEOUT_MS = 15000; // 15s hard timeout per request

// ─── Session registry — tracks active sessions ───────────────────────────────
// Lightweight in-process map; Redis holds the actual history
const activeSessions = new Map<string, { startedAt: number; questionCount: number }>();

function resolveSessionId(req: Request): string {
  // Priority: Hume query param → body field → generate new unique ID
  // NEVER fall back to a shared "default" — that breaks multi-kiosk isolation
  const fromQuery = req.query.custom_session_id as string;
  const fromBody  = req.body?.session_id as string;
  return fromQuery || fromBody || randomUUID();
}

function sessionStart(sessionId: string): void {
  if (!activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, { startedAt: Date.now(), questionCount: 0 });
    console.log(`[gateway] session OPEN  — ${sessionId} | active sessions: ${activeSessions.size}`);
  }
  const s = activeSessions.get(sessionId)!;
  s.questionCount++;
}

function sessionEnd(sessionId: string, durationMs: number): void {
  const s = activeSessions.get(sessionId);
  console.log(
    `[gateway] session CLOSE — ${sessionId} | ` +
    `questions: ${s?.questionCount ?? '?'} | duration: ${durationMs}ms`
  );
}

// ─── Request timeout middleware ───────────────────────────────────────────────
function withRequestTimeout(ms: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        console.error(`[gateway] Request timeout after ${ms}ms`);
        res.status(504).json({ error: 'Request timed out' });
      }
    }, ms);
    res.on('finish', () => clearTimeout(timer));
    res.on('close',  () => clearTimeout(timer));
    next();
  };
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  await getCache();
  console.log('[gateway] Redis initialised');
}
boot().catch(console.error);

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', async (req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'OK',
      db: 'connected',
      activeSessions: activeSessions.size,
      uptime: process.uptime(),
    });
  } catch (err) {
    console.error('[gateway] DB health check failed:', err);
    res.status(500).json({ error: 'DB connection failed' });
  }
});

// ─── PRIMARY: Hume Custom Language Model endpoint ────────────────────────────
// Hume POSTs here with OpenAI-compatible messages array
// We respond with SSE stream of OpenAI chat completion chunks
// Hume dashboard URL: https://bkndkiosk-production.up.railway.app/chat/completions
app.post(
  '/chat/completions',
  withRequestTimeout(REQUEST_TIMEOUT_MS),
  async (req: Request, res: Response) => {
    const requestStart = Date.now();
    const sessionId = resolveSessionId(req);
    sessionStart(sessionId);

    try {
      const { messages } = req.body || {};

      // ── Validate ────────────────────────────────────────────────────────
      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Missing messages array' });
      }

      // ── Extract last user message ────────────────────────────────────────
      const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user');
      if (!lastUserMsg) {
        return res.status(400).json({ error: 'No user message found in messages array' });
      }

      const question = typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content.find((c: any) => c.type === 'text')?.text ?? ''
          : '';

      if (!question.trim()) {
        return res.status(400).json({ error: 'Empty user message' });
      }

      console.log(`[gateway] session=${sessionId} question="${question.slice(0, 80)}"`);

      // ── Set SSE headers ──────────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // critical for Railway/nginx proxies

      // ── Stream response ──────────────────────────────────────────────────
      await askQuestionStreaming(question, sessionId, res, messages);

      sessionEnd(sessionId, Date.now() - requestStart);

    } catch (err: any) {
      console.error(`[gateway] Unhandled error for session=${sessionId}:`, err);
      sessionEnd(sessionId, Date.now() - requestStart);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  }
);

// ─── SECONDARY: Legacy REST endpoint for local testing ───────────────────────
app.post('/ask', async (req: Request, res: Response) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing question' });
    }
    const sessionId = resolveSessionId(req);
    const answer = await askQuestion(question, sessionId);
    return res.json({ answer, sessionId });
  } catch (err: any) {
    console.error('[gateway] /ask error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[gateway] Listening on port ${PORT}`);
  console.log(`[gateway] POST /chat/completions → Hume SSE streaming`);
  console.log(`[gateway] POST /ask              → Local test endpoint`);
});
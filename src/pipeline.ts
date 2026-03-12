// Parallel Pipeline — the speed engine
//
// Fires three tasks simultaneously at t=0:
//   1. Intent classification  (sync, ~0ms)
//   2. Embedding + vector search (~85ms total)
//   3. Session memory lookup  (~5-10ms Redis)
//
// Each step has a timeout — if it stalls, pipeline degrades gracefully
// rather than hanging the whole request.

import OpenAI from 'openai';
import { pool } from './db';
import { getHistory, Message } from './memory';
import { classifyIntent, IntentResult } from './intent';
import { cacheGet, cacheSet } from './cache';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY!;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const EMBEDDING_TIMEOUT_MS = 3000;
const SEARCH_TIMEOUT_MS    = 2000;
const MEMORY_TIMEOUT_MS    = 1000;
const EMBEDDING_CACHE_TTL  = 86400; // 24 hours

export interface PipelineResult {
  context: string;
  history: Message[];
  intentResult: IntentResult;
  timings: {
    intentMs: number;
    embeddingMs: number;
    searchMs: number;
    memoryMs: number;
    totalMs: number;
  };
  degraded: {
    embedding: boolean;
    search: boolean;
    memory: boolean;
  };
}

export async function runParallelPipeline(
  question: string,
  sessionId: string
): Promise<PipelineResult> {
  const pipelineStart = Date.now();

  // ── Step 1: Intent classification (sync, ~0ms) ───────────────────────────
  const intentStart = Date.now();
  const intentResult = classifyIntent(question);
  const intentMs = Date.now() - intentStart;

  // Skip entire pipeline for greetings/farewells
  if (intentResult.skipRAG) {
    return {
      context: '',
      history: [],
      intentResult,
      timings: { intentMs, embeddingMs: 0, searchMs: 0, memoryMs: 0, totalMs: Date.now() - pipelineStart },
      degraded: { embedding: false, search: false, memory: false },
    };
  }

  // ── Step 2: Embedding + memory IN PARALLEL ───────────────────────────────
  const memStart = Date.now();
  const [embeddingOutcome, memoryOutcome] = await Promise.allSettled([
    withTimeout(generateEmbedding(question), EMBEDDING_TIMEOUT_MS, 'embedding'),
    withTimeout(getHistory(sessionId), MEMORY_TIMEOUT_MS, 'memory'),
  ]);

  const embeddingMs = Date.now() - pipelineStart;
  const memoryMs = Date.now() - memStart;

  const embeddingResult = embeddingOutcome.status === 'fulfilled' ? embeddingOutcome.value : null;
  const history         = memoryOutcome.status === 'fulfilled'   ? memoryOutcome.value  : [];

  if (embeddingOutcome.status === 'rejected') console.warn('[pipeline] Embedding timed out');
  if (memoryOutcome.status === 'rejected')    console.warn('[pipeline] Memory timed out');

  // ── Step 3: Vector search ─────────────────────────────────────────────────
  let context = '';
  let searchMs = 0;
  let searchDegraded = false;

  if (embeddingResult) {
    const searchStart = Date.now();
    try {
      context = await withTimeout(vectorSearch(embeddingResult), SEARCH_TIMEOUT_MS, 'vector search');
    } catch {
      console.warn('[pipeline] Vector search timed out');
      searchDegraded = true;
    }
    searchMs = Date.now() - searchStart;
  }

  const totalMs = Date.now() - pipelineStart;

  console.log(
    `[pipeline] session=${sessionId} intent=${intentResult.intent} | ` +
    `embed=${embeddingMs}ms search=${searchMs}ms total=${totalMs}ms`
  );

  return {
    context,
    history,
    intentResult,
    timings: { intentMs, embeddingMs, searchMs, memoryMs, totalMs },
    degraded: {
      embedding: embeddingOutcome.status === 'rejected',
      search: searchDegraded,
      memory: memoryOutcome.status === 'rejected',
    },
  };
}

// ─── Embedding with Redis cache ───────────────────────────────────────────────
async function generateEmbedding(text: string): Promise<number[]> {
  // Normalize key — same question phrased identically hits cache
  const cacheKey = `emb:${text.toLowerCase().trim().replace(/\s+/g, ' ').substring(0, 100)}`;

  // Check Redis cache first
  try {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      console.log('[pipeline] embedding cache HIT');
      return JSON.parse(cached);
    }
  } catch {
    // Cache miss or error — proceed to API call
  }

  // Call OpenAI
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  const embedding = res.data[0].embedding;

  // Store in cache async — don't block
  cacheSet(cacheKey, JSON.stringify(embedding), EMBEDDING_CACHE_TTL).catch(console.error);

  return embedding;
}

// ─── Vector search ────────────────────────────────────────────────────────────
async function vectorSearch(embedding: number[]): Promise<string> {
  const vectorParam = `[${embedding.join(',')}]`;
  const res = await pool.query(
    `SELECT content FROM documents ORDER BY embedding <-> $1::vector LIMIT 3`,
    [vectorParam]
  );
  return res.rows
    .map((r: any) => r.content)
    .filter(Boolean)
    .join('\n\n');
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}
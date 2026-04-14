import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { randomUUID } from 'crypto';
import { runParallelPipeline } from './pipeline';
import { appendHistory } from './memory';
import { cacheGet, cacheSet, normalizeKey } from './cache';
import { CANNED_RESPONSES } from './intent';
import { buildPrompt, buildPromptFromHumeMessages } from './prompt';
import { Response } from 'express';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY!;
const client = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Non-streaming (for /ask test endpoint) ──────────────────────────────────
export async function askQuestion(question: string, sessionId: string): Promise<string> {
  const cacheKey = normalizeKey(question);
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const { context, history, intentResult } = await runParallelPipeline(question, sessionId);

  if (intentResult.skipRAG) {
    const canned = CANNED_RESPONSES[intentResult.intent];
    await cacheSet(cacheKey, canned, 3600);
    return canned;
  }

  const messages: ChatCompletionMessageParam[] = buildPrompt({ context, history, question });

  const res: any = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages,
    temperature: 0.1,
    max_tokens: 120,
  });

  const answer = res.choices?.[0]?.message?.content?.trim() ?? 'I am not sure about that.';
  await Promise.all([
    cacheSet(cacheKey, answer, 3600),
    appendHistory(sessionId, question, answer),
  ]);
  return answer;
}

// ─── Streaming (primary path for Hume) ──────────────────────────────────────
export async function askQuestionStreaming(
  question: string,
  sessionId: string,
  res: Response,
  humeMessages: any[] = []
): Promise<void> {
  const requestId = randomUUID().slice(0, 8);
  console.log(`[rag:${requestId}] session=${sessionId} question="${question.slice(0, 60)}"`);

  // ── 1. Cache check ────────────────────────────────────────────────────────
  const cacheKey = normalizeKey(question);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    console.log(`[rag:${requestId}] cache HIT`);
    streamTokens(cached, res, 'cache');
    return;
  }

  // ── 2. Parallel pipeline ──────────────────────────────────────────────────
  const { context, history, intentResult, timings, degraded } = await runParallelPipeline(question, sessionId);
  console.log(`[rag:${requestId}] pipeline ${timings.totalMs}ms | degraded=${JSON.stringify(degraded)}`);

  // ── 3. Canned response for greetings/farewells ────────────────────────────
  if (intentResult.skipRAG) {
    const canned = CANNED_RESPONSES[intentResult.intent];
    console.log(`[rag:${requestId}] skipRAG intent=${intentResult.intent}`);
    streamTokens(canned, res, 'canned');
    cacheSet(cacheKey, canned, 3600).catch(console.error);
    return;
  }

  // ── 4. Build prompt ───────────────────────────────────────────────────────
  const messages: ChatCompletionMessageParam[] = humeMessages.length > 0
    ? buildPromptFromHumeMessages(humeMessages, context)
    : buildPrompt({ context, history, question });

  // ── 5. Stream from OpenAI → forward tokens to Hume immediately ───────────
  let fullAnswer = '';
  try {
    const stream = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0.2,
      max_tokens: 120,
      stream: true,
    });

    for await (const chunk of stream) {
      const token = chunk.choices?.[0]?.delta?.content ?? '';
      if (token) {
        fullAnswer += token;
        const payload = {
          id: `chatcmpl-${requestId}`,
          object: 'chat.completion.chunk',
          choices: [{ delta: { content: token }, index: 0, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    }
  } catch (err) {
    console.error(`[rag:${requestId}] LLM stream error:`, err);
    const fallback = 'I am having trouble answering that right now. Please try again.';
    streamTokens(fallback, res, requestId);
    return;
  }

  res.write(`data: [DONE]\n\n`);
  res.end();

  console.log(`[rag:${requestId}] complete — ${fullAnswer.length} chars`);

  // ── 6. Persist async — never block the response ───────────────────────────
  Promise.all([
    cacheSet(cacheKey, fullAnswer, 3600),
    appendHistory(sessionId, question, fullAnswer),
  ]).catch(console.error);
}

// ─── Stream a string as word-by-word SSE chunks ───────────────────────────────
function streamTokens(text: string, res: Response, id: string): void {
  const words = text.split(' ');
  for (const word of words) {
    const payload = {
      id: `chatcmpl-${id}`,
      object: 'chat.completion.chunk',
      choices: [{ delta: { content: word + ' ' }, index: 0, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.write(`data: [DONE]\n\n`);
  res.end();
}

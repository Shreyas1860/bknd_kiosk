import OpenAI from 'openai';
import { pool } from './db';

// support either OPENAI_API_KEY or OPEN_API_KEY for flexibility
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY environment variable is not set');
}

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

export async function askQuestion(question: string): Promise<string> {
  // 1) Generate embedding for the question
  const embRes: any = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: question
  });

  const embedding: number[] = embRes.data[0].embedding;

  // 2) Query Postgres using pgvector distance operator
  const vectorParam = `[${embedding.join(',')}]`;

  const q = `SELECT content FROM documents ORDER BY embedding <-> $1::vector LIMIT 5`;
  const res = await pool.query(q, [vectorParam]);

  const contents = res.rows.map((r: any) => r.content).filter(Boolean);
  const context = contents.join('\n\n');

  // 3) Send context + question to OpenAI chat completion
  const systemPrompt = 'You are a helpful AI VOICE KISOK bot talking like a human .Answer using the context provided. If the context contains partial information, answer as best as possible using it. If there is no relevant information, say you do not know.';
  const userPrompt = `Context:\n${context}\n\nQuestion: ${question}`;

  const chatRes: any = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.4,
    max_tokens: 512
  });

  const answer = chatRes.choices?.[0]?.message?.content ?? 'No answer';
  return answer.trim();
}

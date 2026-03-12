import { cacheGet, cacheSet } from './cache';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

const SESSION_TTL = 1800; // 30 minutes
const MAX_TURNS = 6;      // last 6 messages sent to LLM

export async function getHistory(sessionId: string): Promise<Message[]> {
  try {
    const raw = await cacheGet(`session:${sessionId}`);
    if (!raw) return [];
    return JSON.parse(raw) as Message[];
  } catch {
    return [];
  }
}

export async function appendHistory(sessionId: string, userMsg: string, assistantMsg: string): Promise<void> {
  const history = await getHistory(sessionId);
  history.push({ role: 'user', content: userMsg });
  history.push({ role: 'assistant', content: assistantMsg });
  // Keep only last MAX_TURNS messages
  const trimmed = history.slice(-MAX_TURNS);
  await cacheSet(`session:${sessionId}`, JSON.stringify(trimmed), SESSION_TTL);
}

export function buildHistoryMessages(history: Message[]): { role: string; content: string }[] {
  return history.map(m => ({ role: m.role, content: m.content }));
}
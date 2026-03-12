// Intent Router

export type Intent =
  | 'greeting'
  | 'farewell'
  | 'general';

export interface IntentResult {
  intent: Intent;
  skipRAG: boolean;
}

// Anchored with ^ and $ — only matches if the ENTIRE message is a greeting
// "hey" → skipRAG ✅
// "hey what services do you offer" → general, full RAG ✅
// "hi can you help me" → general, full RAG ✅
const GREETING = /^\s*(hi|hello|hey|good\s(morning|afternoon|evening)|howdy)[!.,]?\s*$/i;
const FAREWELL = /^\s*(bye|goodbye|see\syou|take\scare|cya|farewell)[!.,]?\s*$/i;

export function classifyIntent(question: string): IntentResult {
  const q = question.trim();
  if (GREETING.test(q)) return { intent: 'greeting', skipRAG: true };
  if (FAREWELL.test(q)) return { intent: 'farewell', skipRAG: true };
  return { intent: 'general', skipRAG: false };
}

export const CANNED_RESPONSES: Record<string, string> = {
  greeting: 'Hello! Welcome. How can I help you today?',
  farewell: 'Goodbye! Have a great day. Feel free to come back anytime.',
};
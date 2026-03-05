import dotenv from 'dotenv';
import path from 'path';
// Load .env explicitly from project root to avoid runtime path issues
const dotenvResult = dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
if (dotenvResult.error) console.error('dotenv load error:', dotenvResult.error);
// Debug: show whether env vars were loaded (avoids printing secrets)
console.log('ENV: DATABASE_URL present=', !!process.env.DATABASE_URL, 'OPENAI present=', !!(process.env.OPENAI_API_KEY || process.env.OPEN_API_KEY));
dotenv.config();

import express from 'express';
import cors from 'cors';
import { askQuestion } from './rag';
import { pool } from './db';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

app.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'Backend running & DB connected' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

app.post('/ask', async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid `question` in body' });
    }

    const answer = await askQuestion(question);
    return res.json({ answer });
  } catch (err: any) {
    console.error('Error /ask:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`AI Kiosk RAG backend listening on port ${PORT}`);
});

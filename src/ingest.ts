import dotenv from 'dotenv';
dotenv.config();

import { pool } from './db';
import { createEmbedding } from './embed';

async function ingestDocument(text: string) {
  const embedding = await createEmbedding(text);

  await pool.query(
    `INSERT INTO documents (content, embedding)
     VALUES ($1, $2::vector)`,
    [text, JSON.stringify(embedding)]
  );
}

async function main() {
  try {
    const fs = require('fs');
    const path = require('path');
    
    const filePath = path.join(__dirname, 'company_data.txt');
    const data = fs.readFileSync(filePath, 'utf-8');
    
    // Split by sections and insert each
    const sections = data.split('\n\n').filter((s: string) => s.trim().length > 50);
    
    for (const section of sections) {
      console.log(`Ingesting: ${section.substring(0, 50)}...`);
      await ingestDocument(section);
    }
    
    console.log(`✓ Ingested ${sections.length} documents successfully`);
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
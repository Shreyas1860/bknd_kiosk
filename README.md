# AI Kiosk RAG Backend

Manual SQL to run (run in your Postgres DB):

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  content TEXT,
  embedding VECTOR(1536)
);
```

<<<<<<< HEAD
Run (development):
=======
Run:
>>>>>>> 2326d550dd1281ee18e15990a99f166c397a148a

```bash
npm install
cp .env.example .env
# set DATABASE_URL and OPENAI_API_KEY in .env
<<<<<<< HEAD
npm run dev            # starts using ts-node on port 3001
```

Build & Production:

```bash
npm install            # devDependencies are needed for build
npm run build          # compile TypeScript to dist/
npm start              # run compiled JS (no ts-node required)
```

On Railway (or any production host), devDependencies are not installed, so the `npm run build` step
must be executed before deployment. After building you can simply execute `npm start`.

=======
npx ts-node src/index.ts
```
>>>>>>> 2326d550dd1281ee18e15990a99f166c397a148a

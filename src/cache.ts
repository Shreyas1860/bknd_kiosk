import { createClient } from 'redis';

let redisClient: any = null;
const memoryCache = new Map<string, { value: string; expires: number }>();

export async function getCache(): Promise<any> {
  if (redisClient) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) return null; // fallback to memory
  try {
    redisClient = createClient({ url });
    redisClient.on('error', (err: any) => console.error('Redis error:', err));
    await redisClient.connect();
    console.log('✓ Redis connected');
    return redisClient;
  } catch (err) {
    console.warn('Redis unavailable, using in-memory cache');
    redisClient = null;
    return null;
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const client = await getCache();
  if (client) {
    return await client.get(key);
  }
  // Memory fallback
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { memoryCache.delete(key); return null; }
  return entry.value;
}

export async function cacheSet(key: string, value: string, ttlSeconds = 3600): Promise<void> {
  const client = await getCache();
  if (client) {
    await client.setEx(key, ttlSeconds, value);
    return;
  }
  memoryCache.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
}

// Normalize question for cache key
export function normalizeKey(text: string): string {
  return 'q:' + text.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '_').substring(0, 100);
}
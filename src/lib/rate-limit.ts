type RateLimitState = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitState>();

export function consumeRateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    const next = { count: 1, resetAt: now + windowMs };
    buckets.set(key, next);
    return {
      allowed: true,
      remaining: Math.max(limit - 1, 0),
      resetAt: next.resetAt,
    };
  }

  current.count += 1;
  const allowed = current.count <= limit;

  return {
    allowed,
    remaining: Math.max(limit - current.count, 0),
    resetAt: current.resetAt,
  };
}

export function getClientIdentifier(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

/* Small token-bucket limiter, keyed by whatever the caller passes
   (socket id, IP). No dependencies so it is trivially testable. */

export function createLimiter({ tokens, perMs }){
  const buckets = new Map();

  function allow(key){
    const now = Date.now();
    let b = buckets.get(key);
    if(!b){ b = { left: tokens, resetAt: now + perMs }; buckets.set(key, b); }
    if(now >= b.resetAt){ b.left = tokens; b.resetAt = now + perMs; }
    if(b.left <= 0) return false;
    b.left--;
    return true;
  }

  /* Call occasionally so departed sockets/IPs don't accumulate. */
  function sweep(){
    const now = Date.now();
    for(const [k, b] of buckets) if(now >= b.resetAt) buckets.delete(k);
  }

  return { allow, sweep };
}

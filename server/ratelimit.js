/* Small token-bucket limiter, keyed by whatever the caller passes
   (socket id, IP). No dependencies so it is trivially testable. */

export function createLimiter({ tokens, perMs }){
  const buckets = new Map();

  function bucket(key){
    const now = Date.now();
    let b = buckets.get(key);
    if(!b){ b = { left: tokens, resetAt: now + perMs }; buckets.set(key, b); }
    if(now >= b.resetAt){ b.left = tokens; b.resetAt = now + perMs; }
    return b;
  }

  function allow(key){
    const b = bucket(key);
    if(b.left <= 0) return false;
    b.left--;
    return true;
  }

  /* CHECK WITHOUT SPENDING, so a password endpoint can charge for FAILURES
     only. Charging for every attempt means the honest case pays too: a
     household behind one NAT shares this key, and locking them out because
     six people typed the right code is a worse outcome than the one the
     limit exists to prevent. Getting it right lets the bucket be small and
     the window long, which is what actually stops guessing. */
  function peek(key){ return bucket(key).left > 0; }
  function spend(key){ const b = bucket(key); if(b.left > 0) b.left--; }

  /* Call occasionally so departed sockets/IPs don't accumulate. */
  function sweep(){
    const now = Date.now();
    for(const [k, b] of buckets) if(now >= b.resetAt) buckets.delete(k);
  }

  return { allow, peek, spend, sweep };
}

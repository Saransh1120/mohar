import test from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "./limiter.js";

function clocked() {
  let t = 1_000_000;
  const limiter = new RateLimiter(() => t);
  return { limiter, advance: (ms: number) => (t += ms) };
}

const FIVE_A_MINUTE = { burst: 5, perMinute: 5 };

test("the burst is allowed at once and the next request is refused", () => {
  const { limiter } = clocked();
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.take("access", "d:1", FIVE_A_MINUTE).allowed, true, `request ${i + 1}`);
  }
  const sixth = limiter.take("access", "d:1", FIVE_A_MINUTE);
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.retryAfterSeconds, 12, "one request comes back every 12 s at 5 a minute");
});

test("the allowance comes back at the stated rate, not all at once", () => {
  const { limiter, advance } = clocked();
  for (let i = 0; i < 5; i++) limiter.take("access", "d:1", FIVE_A_MINUTE);
  advance(11_000);
  assert.equal(limiter.take("access", "d:1", FIVE_A_MINUTE).allowed, false, "11 s is not enough");
  advance(1_000);
  assert.equal(limiter.take("access", "d:1", FIVE_A_MINUTE).allowed, true, "12 s is one request");
  assert.equal(limiter.take("access", "d:1", FIVE_A_MINUTE).allowed, false, "and only one");
});

test("a refused request does not push the wait further out", () => {
  const { limiter, advance } = clocked();
  for (let i = 0; i < 5; i++) limiter.take("access", "d:1", FIVE_A_MINUTE);
  // Hammering while refused must not reset the refill, or a caller who keeps
  // trying would never be let back in.
  for (let i = 0; i < 50; i++) {
    advance(100);
    limiter.take("access", "d:1", FIVE_A_MINUTE);
  }
  advance(7_100);
  assert.equal(limiter.take("access", "d:1", FIVE_A_MINUTE).allowed, true);
});

test("the allowance never grows past the burst, however long the caller was idle", () => {
  const { limiter, advance } = clocked();
  limiter.take("access", "d:1", FIVE_A_MINUTE);
  advance(24 * 3600_000);
  let allowed = 0;
  for (let i = 0; i < 20; i++) if (limiter.take("access", "d:1", FIVE_A_MINUTE).allowed) allowed++;
  assert.equal(allowed, 5);
});

test("callers and limits are counted apart", () => {
  const { limiter } = clocked();
  for (let i = 0; i < 5; i++) limiter.take("access", "d:1", FIVE_A_MINUTE);
  assert.equal(limiter.take("access", "d:2", FIVE_A_MINUTE).allowed, true, "another device");
  assert.equal(limiter.take("read", "d:1", FIVE_A_MINUTE).allowed, true, "another limit");
});

test("peek reports the allowance without spending it", () => {
  const { limiter } = clocked();
  for (let i = 0; i < 10; i++) assert.equal(limiter.peek("x", "k", FIVE_A_MINUTE).allowed, true);
  for (let i = 0; i < 5; i++) limiter.take("x", "k", FIVE_A_MINUTE);
  const p = limiter.peek("x", "k", FIVE_A_MINUTE);
  assert.equal(p.allowed, false);
  assert.equal(p.retryAfterSeconds, 12);
});

test("idle buckets are dropped by the sweep and behave as full afterwards", () => {
  const { limiter, advance } = clocked();
  for (let i = 0; i < 5; i++) limiter.take("access", "d:1", FIVE_A_MINUTE);
  assert.equal(limiter.size, 1);
  advance(2 * 3600_000);
  limiter.sweep();
  assert.equal(limiter.size, 0);
  assert.equal(limiter.take("access", "d:1", FIVE_A_MINUTE).allowed, true);
});

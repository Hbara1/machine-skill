// node software/tests/checkout-model.test.mjs : runs the checkout API queueing model from the example page headless
import { readFileSync } from 'node:fs'
globalThis.window = {}
const SK = (await import('../kit/soft-kit.js')).default
const src = readFileSync(new URL('../examples/checkout-api.html', import.meta.url), 'utf8')
const model = src.split('// ------------------------------------------------------------------ model:start')[1].split('// ------------------------------------------------------------------ model:end')[0]
const { steady, SYS } = new Function('SK', `${model}; return { steady, SYS }`)(SK)
const row = (p) => { const r = steady(p); console.log(JSON.stringify(p), `S ${(r.s.mean * 1e3).toFixed(0)} ms (p99 ${(r.s.p99 * 1e3).toFixed(0)})  cap ${r.cap.toFixed(0)}/s  busy ${(r.busy * 100).toFixed(0)} %  p99 ${(r.p99 * 1e3).toFixed(0)} ms  thr ${r.thr.toFixed(0)}/s  fail ${(r.fail * 100).toFixed(1)} %  calls ${r.calls.toFixed(0)}/s (x${r.amp.toFixed(2)})  inflight ${r.inflight.toFixed(0)}  db ${(r.dbBusy * 100).toFixed(0)} %`); return r }
const a = row({ lambda: 300, retries: 3, slow: 0 })
row({ lambda: 600, retries: 3, slow: 0 })
const b = row({ lambda: 300, retries: 3, slow: 0.6 })
const c = row({ lambda: 300, retries: 0, slow: 0.6 })
row({ lambda: 50, retries: 3, slow: 0.6 })
// a fluid queue cross-check: at the healthy point it settles near the busy-thread count Little's law gives
const fq = new SK.FluidQueue(); for (let i = 0; i < 4000; i++) fq.step(0.01, 300, 1 / a.s.mean, a.c)
let fail = 0
const ok = (cond, msg) => { if (!cond) { fail++; console.log('FAIL', msg) } }
ok(a.stable && a.p99 > 0.3 && a.p99 < 1.2, 'healthy p99 should be a few hundred ms')
ok(Math.abs(a.busy - 300 * a.s.mean / 128) < 1e-9, 'utilisation is lambda S / c')
ok(a.cap > 550 && a.cap < 700, 'healthy capacity near 128 / 0.2 s')
ok(!b.stable && b.fail > 0.5, 'a provider hanging 60 % of calls should overload the pool')
ok(b.amp > 2 && b.amp < 2.3, 'three retries at p = 0.6 send about 2.18 calls per checkout')
ok(c.cap > b.cap, 'fewer retries leave more capacity')
ok(Math.abs(fq.N - 300 * a.s.mean) / (300 * a.s.mean) < 0.02, `fluid queue settles at L = lambda S (${fq.N.toFixed(1)})`)
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0)

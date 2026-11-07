// node software/tests/ecg-model.test.mjs : runs the ECG patch firmware model from the example page headless
import { readFileSync } from 'node:fs'
globalThis.window = {}
const SK = (await import('../kit/soft-kit.js')).default
const src = readFileSync(new URL('../examples/ecg-patch.html', import.meta.url), 'utf8')
const model = src.split('// ------------------------------------------------------------------ model:start')[1].split('// ------------------------------------------------------------------ model:end')[0]
const firmware = new Function('SK', `${model}; return { firmware, HW }`)(SK).firmware
const run = (p) => SK.analyse(6, (sim) => { const fw = firmware(sim, p); sim.runUntil(1); fw.os.resetStats(); return () => fw.stats() })
const row = (p) => { const r = run(p); console.log(JSON.stringify(p), `days ${r.days.toFixed(1)}  I ${(r.I * 1e6).toFixed(0)} uA  load ${(r.load * 100).toFixed(2)} %  drops/s ${r.drops.toFixed(2)}  lat ${(r.lat * 1e6).toFixed(0)} us  blocked ${(r.acqBlocked * 1e3).toFixed(2)} ms  B/event ${r.perEvent.toFixed(0)}  share ${Object.entries(r.share).map(([k, v]) => k + ' ' + (v * 100).toFixed(0)).join(' ')}`); return r }
const a = row({ sps: 250, ci: 0.03, lock: 'mutex' })
const b = row({ sps: 250, ci: 0.03, lock: 'binary' })
row({ sps: 1000, ci: 0.03, lock: 'mutex' }); row({ sps: 1000, ci: 0.03, lock: 'binary' })
row({ sps: 125, ci: 0.1, lock: 'mutex' }); row({ sps: 250, ci: 0.0075, lock: 'mutex' })
let fail = 0
if (a.drops !== 0) { fail++; console.log('FAIL mutex should drop nothing') }
if (!(b.drops > 1)) { fail++; console.log('FAIL binary semaphore should drop samples') }
if (!(a.days > 5 && a.days < 60)) { fail++; console.log('FAIL battery life out of a plausible range') }
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0)

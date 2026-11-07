// node software/tests/sim.test.mjs : checks the scheduler and queueing models against hand results
import { Sim, Rtos, rta, llBound, mmc, erlangC, bus, ble } from '../kit/soft-kit.js'
let fail = 0
const ok = (c, m) => { if (!c) { fail++; console.log('FAIL', m) } else console.log('ok  ', m) }
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b}`)

// 1. two periodic tasks, rate monotonic: C1=1 T1=4 (high), C2=2 T2=6 -> R2 = 2 + ceil(R/4)*1 = 3
{
  const sim = new Sim(); const os = new Rtos(sim)
  os.task({ name: 'A', prio: 2, period: 4e-3, steps: [{ cpu: 1e-3 }] })
  os.task({ name: 'B', prio: 1, period: 6e-3, steps: [{ cpu: 2e-3 }] })
  sim.runUntil(0.12); os.sync()
  near(os.tasks.B.stats.maxResp, 3e-3, 1e-9, 'RM worst response of B equals RTA')
  near(rta([{ name: 'A', C: 1, T: 4, prio: 2 }, { name: 'B', C: 2, T: 6, prio: 1 }])[1].R, 3, 1e-12, 'rta() B')
  near(os.load(), 1 / 4 + 2 / 6, 0.01, 'load = sum C/T')
  near(llBound(2), 0.8284, 1e-4, 'Liu-Layland n=2')
}
// 2. priority inversion: L holds m, M preempts, H blocks for M's whole run without inheritance
for (const inherit of [true, false]) {
  const sim = new Sim(); const os = new Rtos(sim); os.mutex('m', { inherit })
  os.task({ name: 'L', prio: 1, steps: [{ take: 'm' }, { cpu: 1e-3 }, { call: (o) => o.release('M') }, { cpu: 1e-3 }, { give: 'm' }] })
  os.task({ name: 'M', prio: 2, steps: [{ cpu: 10e-3 }] })
  os.task({ name: 'H', prio: 3, steps: [{ take: 'm' }, { cpu: 0.5e-3 }, { give: 'm' }] })
  sim.at(0, () => os.release('L'))
  sim.at(1.5e-3, () => os.release('H'))
  sim.runUntil(0.05); os.sync()
  const b = os.tasks.H.stats.maxBlocked
  if (inherit) near(b, 1e-3, 1e-9, 'inheritance: H blocked only for L remaining critical section (1 ms)')
  else near(b, 10.5e-3, 1e-9, "no inheritance: H blocked for the rest of M (9.5 ms) plus L remainder (1 ms)")
}
// 3. wait (I/O) frees the core
{
  const sim = new Sim(); const os = new Rtos(sim)
  os.task({ name: 'IO', prio: 2, steps: [{ cpu: 1e-3 }, { wait: 5e-3 }, { cpu: 1e-3 }] })
  os.task({ name: 'BG', prio: 1, steps: [{ cpu: 3e-3 }] })
  sim.at(0, () => { os.release('IO'); os.release('BG') })
  sim.runUntil(0.02); os.sync()
  near(os.tasks.BG.stats.maxResp, 4e-3, 1e-9, 'background runs while the high task waits on I/O')
  near(os.tasks.IO.stats.maxResp, 7e-3, 1e-9, 'I/O task response')
}
// 4. overrun: ISR releases a task that is still pending
{
  const sim = new Sim(); const os = new Rtos(sim)
  os.task({ name: 'T', prio: 1, maxPending: 1, steps: [{ cpu: 3e-3 }] })
  os.isr({ name: 'I', prio: 100, period: 2e-3, cpu: 10e-6, then: (o) => o.release('T') })
  sim.runUntil(0.1); os.sync()
  ok(os.tasks.T.stats.overruns > 10, `overruns counted (${os.tasks.T.stats.overruns})`)
}
// 5. queueing: M/M/1 W = 1/(mu-lambda); Erlang C known value C(2, 1) = 1/3
near(mmc(8, 10, 1).W, 0.5, 1e-12, 'M/M/1 sojourn')
near(erlangC(2, 1), 1 / 3, 1e-12, 'Erlang C(2,1)')
near(bus.spi(9, 4e6, 0), 18e-6, 1e-12, 'SPI 9 bytes at 4 MHz')
near(ble.air(20) * 1e6, 296, 1e-6, 'BLE 1M PDU with 20 B ATT payload airtime (us)')
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0)

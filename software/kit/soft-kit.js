// Machine Skill, software module: the runtime for software, firmware and embedded system pages.
// One ES module that sits on top of kit/lab-kit.js. Paste it into the second <script type="module">
// of a page (scripts/inline.mjs does that), after lab-kit, and read it from window.SoftKit.
// MIT licence, see LICENSE.
//
// Software has no silhouette, so it is shown two ways at once, both driven by the same solver:
//   the hardware   the real board or the real system as a 3D object (PCB, packages, passives, cells, service blocks)
//   the software   a live trace panel (logic analyser and scheduler timeline) and discrete packets moving on the hardware
//
// What it adds to lab-kit:
//   sim         Sim (discrete event clock), Rtos (fixed priority preemptive scheduler with mutexes,
//               priority inheritance, ISRs, I/O waits, overruns, deadline misses), rta() and llBound()
//   models      bus timing (SPI, I2C, UART, BLE LE 1M/2M), Power (charge by state, battery life),
//               queueing (Erlang C, M/M/c, Little), FluidQueue for overload transients, retry amplification
//   hardware    MATX electronics materials, board() with copper, pads and silkscreen drawn per layer,
//               ic() packages (QFN, QFP, SOIC, BGA, LGA), chips() for 0201 to 1206 passives as instances,
//               xtal(), coinCell(), snap(), module() service blocks, column() queue gauges, platters()
//   motion      Packets (discrete tokens that ride a trace, a bus or a pipe), Waves (radio rings)
//   panel       Trace: lanes for tasks, ISRs, buses, analog signals and states, synced to the solver clock
//               Strip: the output a person would see (an ECG on the phone, requests at the edge), in real time
//
// The page script never touches internals: everything goes through window.SoftKit.

const LK = () => {
  const k = typeof window !== 'undefined' ? window.LabKit : null
  if (!k) throw new Error('soft-kit: load kit/lab-kit.js first (window.LabKit is missing)')
  return k
}

// ================================================================ the clock

/** Discrete event simulation clock. Times in seconds. sim.at(t, fn), sim.after(dt, fn), sim.every(T, fn, phase) */
export class Sim {
  constructor() { this.now = 0; this.h = []; this.seq = 0 }
  at(t, fn) { const e = { t: Math.max(t, this.now), s: this.seq++, fn }; this._push(e); return e }
  after(dt, fn) { return this.at(this.now + dt, fn) }
  every(T, fn, phase = 0) {
    const tick = () => { if (fn(this) !== false) this.at(this.now + T, tick) }
    return this.at(this.now + phase, tick)
  }
  cancel(e) { if (e) e.fn = null }
  next() { return this.h.length ? this.h[0].t : Infinity }
  /** run every event with t <= T, then set now = T */
  runUntil(T) { while (this.h.length && this.h[0].t <= T) { const e = this._pop(); this.now = e.t; e.fn?.(this) } this.now = Math.max(this.now, T) }
  _less(a, b) { return a.t < b.t || (a.t === b.t && a.s < b.s) }
  _push(e) { const h = this.h; h.push(e); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!this._less(h[i], h[p])) break; [h[i], h[p]] = [h[p], h[i]]; i = p } }
  _pop() {
    const h = this.h, top = h[0], last = h.pop()
    if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && this._less(h[l], h[m])) m = l; if (r < h.length && this._less(h[r], h[m])) m = r; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m } }
    return top
  }
}

// ================================================================ the scheduler

/**
 * Single core, fixed priority, preemptive (FreeRTOS, Zephyr, ThreadX, an NVIC). Higher prio runs first.
 *   const os = new Rtos(sim, { onSeg(lane, t0, t1, kind, job) {...} })
 *   os.task({ name:'Acquire', prio:4, steps: [ {take:'buf'}, {cpu:8e-6}, {wait:18e-6}, {give:'buf'} ], period, phase, deadline, maxPending:1 })
 *   os.isr({ name:'DRDY', prio:100, cpu:6e-6, then: () => os.release('Acquire') })
 *   os.mutex('buf', { inherit: true })     // false = binary semaphore, no priority inheritance
 *   os.release('Acquire')                  // from an ISR or a call step; false if it overran (job already pending)
 * Steps: {cpu: s} runs on the core, {wait: s} blocks on I/O with the core free, {take: m} / {give: m},
 *        {call: (os, job) => ...} runs instantly (notify a task, start a DMA, emit a packet).
 *   steps may also be a function (job) => steps, built fresh at each release.
 * Stats per task: jobs, done, overruns, misses, maxResp, sumResp, cpu, maxBlocked. os.load(): busy / elapsed.
 */
export class Rtos {
  constructor(sim, o = {}) {
    this.sim = sim; this.o = o
    this.tasks = {}; this.ready = []; this.mutexes = {}
    this.cur = null; this.busy = 0; this.t0 = sim.now; this.last = sim.now
    this.onSeg = o.onSeg ?? null
    this.ctx = o.contextSwitch ?? 0
  }
  mutex(name, { inherit = true } = {}) { this.mutexes[name] = { name, inherit, owner: null, waiters: [] }; return this.mutexes[name] }
  task(o) {
    const t = { prio: 1, maxPending: 1, ...o, isr: false, pending: 0, stats: { jobs: 0, done: 0, overruns: 0, misses: 0, maxResp: 0, sumResp: 0, cpu: 0, maxBlocked: 0 } }
    this.tasks[t.name] = t
    if (t.period) this.sim.every(t.period, () => { this.release(t.name) }, t.phase ?? 0)
    return t
  }
  isr(o) { const t = this.task({ maxPending: 4, ...o, steps: o.steps ?? [{ cpu: o.cpu ?? 2e-6 }, ...(o.then ? [{ call: o.then }] : [])] }); t.isr = true; return t }
  /** release one job of a task now. Returns false (and counts an overrun) if maxPending jobs are already queued. */
  release(name, data) {
    const t = this.tasks[name]; if (!t) throw new Error(`no task ${name}`)
    this._account()
    if (t.pending >= t.maxPending) { t.stats.overruns++; this.o.onOverrun?.(t, this.sim.now); return false }
    const steps = typeof t.steps === 'function' ? t.steps(data) : t.steps
    const job = { task: t, prio: t.prio, eff: t.prio, rel: this.sim.now, steps: steps.map((s) => ({ ...s })), i: 0, left: 0, blocked: null, waitUntil: 0, blockedAt: 0, data }
    t.pending++; t.stats.jobs++
    this.ready.push(job)
    this._advance(job)
    this._dispatch()
    return true
  }
  /** the running job's effective priority picks the core; ties go to the earliest released */
  _pick() {
    let best = null
    for (const j of this.ready) if (!j.blocked && j.waitUntil <= this.sim.now + 1e-15 && !j.done) { if (!best || j.eff > best.eff || (j.eff === best.eff && j.rel < best.rel)) best = j }
    return best
  }
  // credit the time since the last decision to whoever ran, and draw it
  _account() {
    const now = this.sim.now, dt = now - this.last
    if (dt > 0) {
      const j = this.cur
      if (j && j.left > 0) {
        const run = Math.min(dt, j.left); j.left -= run; this.busy += run; j.task.stats.cpu += run
        this.onSeg?.(j.task.name, this.last, this.last + run, j.task.isr ? 'isr' : 'run', j)
        if (run < dt) this.onSeg?.('idle', this.last + run, now, 'idle')
      } else this.onSeg?.('idle', this.last, now, 'idle')
    }
    this.last = now
    // a job whose cpu step just ran out moves on now, even if a release preempts it at this same instant
    const j = this.cur
    if (j && !j.done && j.left <= 1e-15) { const s = j.steps[j.i]; if (s && s.cpu !== undefined && s._started) { j.left = 0; this._advance(j) } }
  }
  // process instant steps until the job needs the core, blocks, waits or ends
  _advance(j) {
    const sim = this.sim
    while (j.i < j.steps.length) {
      const s = j.steps[j.i]
      if (s.cpu !== undefined) { if (j.left <= 0 && !s._started) { s._started = true; j.left = s.cpu } if (j.left > 1e-15) return; j.left = 0; j.i++; continue }
      if (s.wait !== undefined) {
        if (!s._started) { s._started = true; j.waitUntil = sim.now + s.wait; this.onSeg?.(j.task.name, sim.now, j.waitUntil, 'wait', j); sim.at(j.waitUntil, () => { this._account(); this._dispatch() }); return }
        if (j.waitUntil > sim.now + 1e-15) return
        j.i++; continue
      }
      if (s.take) {
        const m = this.mutexes[s.take]
        if (!m.owner || m.owner === j) { m.owner = j; j.i++; continue }
        j.blocked = m; j.blockedAt = sim.now; m.waiters.push(j)
        if (m.inherit) this._boost(m.owner, j.eff)
        return
      }
      if (s.give) {
        const m = this.mutexes[s.give]
        if (m.owner === j) {
          m.owner = null
          j.eff = j.prio
          for (const mm of Object.values(this.mutexes)) if (mm.owner === j && mm.inherit) for (const w of mm.waiters) j.eff = Math.max(j.eff, w.eff)
          if (m.waiters.length) {
            m.waiters.sort((a, b) => b.eff - a.eff || a.rel - b.rel)
            const w = m.waiters.shift(); w.blocked = null; m.owner = w; w.i++
            const bl = sim.now - w.blockedAt; w.task.stats.maxBlocked = Math.max(w.task.stats.maxBlocked, bl)
            this.onSeg?.(w.task.name, w.blockedAt, sim.now, 'blocked', w)
            if (m.inherit) for (const ww of m.waiters) this._boost(w, ww.eff)
            this._advance(w)
          }
        }
        j.i++; continue
      }
      if (s.call) { s.call(this, j); j.i++; continue }
      j.i++
    }
    this._finish(j)
  }
  _boost(j, p) { if (p > j.eff) { j.eff = p; if (j.blocked && j.blocked.inherit && j.blocked.owner) this._boost(j.blocked.owner, p) } }
  _finish(j) {
    if (j.done) return
    j.done = true
    const t = j.task, r = this.sim.now - j.rel
    t.pending--; t.stats.done++; t.stats.sumResp += r; t.stats.maxResp = Math.max(t.stats.maxResp, r)
    if (t.deadline && r > t.deadline + 1e-12) { t.stats.misses++; this.o.onMiss?.(t, this.sim.now, r) }
    this.o.onDone?.(t, j, r)
    this.ready = this.ready.filter((x) => x !== j)
    if (this.cur === j) this.cur = null
  }
  _dispatch() {
    // jobs whose wait has ended continue
    for (const j of [...this.ready]) if (!j.done && !j.blocked && j.waitUntil > 0 && j.waitUntil <= this.sim.now + 1e-15) { j.waitUntil = 0; this._advance(j) }
    const j = this._pick()
    if (j && j !== this.cur && this.ctx > 0 && j.left > 0) j.left += this.ctx
    this.cur = j
    if (j && j.left > 0) {
      const end = this.sim.now + j.left
      const tag = (j._tag = (j._tag ?? 0) + 1)
      this.sim.at(end, () => { if (this.cur === j && j._tag === tag) { this._account(); this._dispatch() } })
    }
  }
  /** call once per frame (or before reading stats) so the running job's time is credited up to sim.now */
  sync() { this._account() }
  load() { return this.busy / Math.max(1e-12, this.sim.now - this.t0) }
  resetStats() { this._account(); this.busy = 0; this.t0 = this.sim.now; for (const t of Object.values(this.tasks)) t.stats = { jobs: 0, done: 0, overruns: 0, misses: 0, maxResp: 0, sumResp: 0, cpu: 0, maxBlocked: 0 } }
}

/** Liu and Layland utilisation bound for n periodic tasks under rate monotonic priorities */
export const llBound = (n) => n * (Math.pow(2, 1 / n) - 1)

/**
 * Exact response time analysis (Joseph and Pandya): R = C + B + sum over higher prio j of ceil(R / Tj) * Cj
 *   rta([{ name, C, T, prio, B }]) -> [{ name, R, ok }] ; R = Infinity when it does not converge before the deadline
 */
export function rta(tasks) {
  return tasks.map((t) => {
    const hp = tasks.filter((u) => u.prio > t.prio)
    let R = t.C + (t.B ?? 0), prev = -1, n = 0
    while (R !== prev && n++ < 1000) { prev = R; R = t.C + (t.B ?? 0) + hp.reduce((a, u) => a + Math.ceil(prev / u.T - 1e-12) * u.C, 0); if (R > (t.D ?? t.T) * 4) return { name: t.name, R: Infinity, ok: false } }
    return { name: t.name, R, ok: R <= (t.D ?? t.T) }
  })
}

// ================================================================ buses, radios, power

export const bus = {
  /** SPI transfer time: bytes * 8 / f + chip select setup and hold */
  spi: (bytes, hz, cs = 1e-6) => (bytes * 8) / hz + cs,
  /** I2C: start, address byte, data bytes, each 9 clocks with the ACK, stop */
  i2c: (bytes, hz, addrBytes = 1) => ((addrBytes + bytes) * 9 + 2) / hz,
  /** UART: 10 bits per byte for 8N1 */
  uart: (bytes, baud, bits = 10) => (bytes * bits) / baud,
  /** CAN 2.0A worst case frame bits with stuffing for n data bytes: 47 + 8n + floor((34 + 8n - 1) / 4) */
  can: (n, bps) => (47 + 8 * n + Math.floor((34 + 8 * n - 1) / 4)) / bps,
}

/**
 * Bluetooth LE link layer timing (Core spec 5.x, uncoded PHY).
 *   ble.air(payload, phy)       on-air time of one PDU with an ATT notification of `payload` bytes
 *   ble.event(bytes, o)         one connection event that carries `bytes` of notifications: packets, radio on time
 */
export const ble = {
  T_IFS: 150e-6,
  // preamble (1 or 2) + access address 4 + header 2 + L2CAP 4 + ATT opcode and handle 3 + payload + CRC 3
  air: (payload, phy = 1e6) => (((phy === 2e6 ? 2 : 1) + 4 + 2 + 4 + 3 + payload + 3) * 8) / phy,
  empty: (phy = 1e6) => (((phy === 2e6 ? 2 : 1) + 4 + 2 + 3) * 8) / phy,
  event(bytes, { phy = 1e6, mtuPayload = 244, central = true } = {}) {
    const n = Math.max(0, Math.ceil(bytes / mtuPayload))
    let tx = 0, rx = 0
    // the central polls first with an empty PDU, the peripheral answers with data, repeated per packet
    const k = Math.max(1, n)
    for (let i = 0; i < k; i++) { const p = i < n ? Math.min(mtuPayload, bytes - i * mtuPayload) : 0; rx += this.empty(phy); tx += p ? this.air(p, phy) : this.empty(phy) }
    const gaps = (2 * k - 1) * this.T_IFS
    return { packets: n, tx, rx, gaps, span: tx + rx + gaps }
  },
}

/**
 * Charge accounting by state: p.add('cpu', seconds) or p.addCharge(coulombs), p.avg() -> amps over the window
 *   new Power({ cpu: 3.7e-3, sleep: 1.9e-6, tx: 5.3e-3, rx: 5.4e-3, afe: 0.22e-3 })
 *   p.life(capacity_mAh, derate) -> hours
 */
export class Power {
  constructor(states) { this.I = states; this.Q = {}; this.T = 0 }
  add(state, s) { this.Q[state] = (this.Q[state] ?? 0) + this.I[state] * s }
  addCharge(state, q) { this.Q[state] = (this.Q[state] ?? 0) + q }
  span(s) { this.T += s }
  avg() { return Object.values(this.Q).reduce((a, b) => a + b, 0) / Math.max(1e-12, this.T) }
  share() { const tot = Object.values(this.Q).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(this.Q).map(([k, v]) => [k, v / tot])) }
  life(mAh, derate = 0.85) { return (mAh * 1e-3 * derate) / Math.max(1e-12, this.avg()) }
  reset() { this.Q = {}; this.T = 0 }
}

// ================================================================ queueing

/** Erlang C: probability an arrival waits, for c servers at offered load a = lambda / mu (Erlangs) */
export function erlangC(c, a) {
  if (a >= c) return 1
  let term = 1, sum = 1
  for (let k = 1; k < c; k++) { term *= a / k; sum += term }
  const last = term * (a / c) * (c / (c - a))
  return last / (sum + last)
}

/**
 * M/M/c steady state. lambda and mu in 1/s. Returns rho, Pw, Wq, W, Lq, L and wait percentiles.
 *   P(Wq > t) = Pw * exp(-(c mu - lambda) t), so the q-quantile of the wait is ln(Pw / (1 - q)) / (c mu - lambda)
 */
export function mmc(lambda, mu, c) {
  const a = lambda / mu, rho = a / c
  if (rho >= 1) return { rho, Pw: 1, Wq: Infinity, W: Infinity, Lq: Infinity, L: Infinity, wq: () => Infinity, w: () => Infinity, stable: false }
  const Pw = erlangC(c, a), gap = c * mu - lambda
  const Wq = Pw / gap, W = Wq + 1 / mu
  const wq = (q) => Math.max(0, Math.log(Pw / (1 - q)) / gap)
  // response time quantile: wait quantile plus the service quantile, a safe upper estimate
  const w = (q) => wq(q) + -Math.log(1 - q) / mu
  return { rho, Pw, Wq, W, Lq: lambda * Wq, L: lambda * W, wq, w, stable: true }
}

/** Little's law: L = lambda * W */
export const little = { L: (lambda, W) => lambda * W, W: (L, lambda) => L / Math.max(1e-12, lambda), lambda: (L, W) => L / Math.max(1e-12, W) }

/**
 * A fluid queue for transients that steady state cannot show (overload, recovery, retry storms).
 *   q.step(dt, lambda, mu, c) integrates dN/dt = lambda - mu * min(c, N); N counts waiting plus in service.
 *   q.N, q.served (throughput, 1/s), q.W (Little's law sojourn estimate, s), q.cap drops arrivals beyond it.
 */
export class FluidQueue {
  constructor({ cap = Infinity } = {}) { this.N = 0; this.cap = cap; this.served = 0; this.dropped = 0; this.W = 0 }
  step(dt, lambda, mu, c) {
    const out = mu * Math.min(c, this.N)
    let N = this.N + (lambda - out) * dt
    if (N > this.cap) { this.dropped = (N - this.cap) / dt; N = this.cap } else this.dropped = 0
    this.N = Math.max(0, N); this.served = out
    this.W = this.served > 1e-9 ? this.N / this.served : 0
    return this
  }
}

/** load multiplied by retries: a request that fails with probability p and is retried up to r times sends sum p^k for k = 0..r */
export const retryAmplification = (p, r) => { let s = 0; for (let k = 0; k <= r; k++) s += Math.pow(p, k); return s }

// ================================================================ electronics materials

/**
 * MATX: what boards are made of. Every preset takes overrides like MAT.*
 *   mask(colour) soldermask, fr4 laminate edge, enig gold pads, tin solder, copper, mold epoxy package,
 *   die silicon, mlcc ceramic, resistor, ferrite, kapton, shield (tin plated steel), silicone (frosted housing)
 */
export const MATX = {
  fr4: (o) => LK().mat({ color: [0.47, 0.44, 0.3], roughness: 0.62, metalness: 0, finish: 'cast', ...o }),
  enig: (o) => LK().MAT.gold({ roughness: 0.22, ...o }),
  tin: (o) => LK().mat({ color: [0.8, 0.8, 0.79], roughness: 0.32, metalness: 1, finish: null, ...o }),
  copper: (o) => LK().MAT.copper({ roughness: 0.3, ...o }),
  mold: (o) => LK().mat({ color: [0.035, 0.035, 0.038], roughness: 0.62, metalness: 0, finish: 'cast', ...o }),
  die: (o) => LK().mat({ color: [0.22, 0.22, 0.28], roughness: 0.08, metalness: 0.6, finish: null, ...o }),
  mlcc: (o) => LK().mat({ color: [0.55, 0.43, 0.3], roughness: 0.55, metalness: 0, finish: 'cast', ...o }),
  resistor: (o) => LK().mat({ color: [0.05, 0.05, 0.05], roughness: 0.5, metalness: 0, finish: 'cast', ...o }),
  ferrite: (o) => LK().mat({ color: [0.12, 0.12, 0.12], roughness: 0.48, metalness: 0.1, finish: 'cast', ...o }),
  kapton: (o) => LK().mat({ color: [0.85, 0.48, 0.08], roughness: 0.2, metalness: 0, transmission: 0.3, thickness: 0.0001, finish: null, ...o }),
  shield: (o) => LK().mat({ color: [0.78, 0.78, 0.76], roughness: 0.28, metalness: 1, finish: 'brushed', ...o }),
  silicone: (o) => LK().mat({ color: [0.92, 0.93, 0.95], roughness: 0.42, metalness: 0, transmission: 0.55, thickness: 0.002, ior: 1.41, transparent: true, finish: null, ...o }),
  ceramic: (o) => LK().MAT.ceramic({ color: [0.9, 0.89, 0.86], ...o }),
}
/** soldermask base colours (sRGB-ish linear triplets as the kit expects) */
export const MASK = { green: [0.03, 0.2, 0.08], black: [0.018, 0.019, 0.021], blue: [0.02, 0.06, 0.2], purple: [0.17, 0.05, 0.3], red: [0.35, 0.03, 0.03], white: [0.88, 0.88, 0.86], matteBlack: [0.022, 0.022, 0.024] }

// ================================================================ boards

const toCss = (c, k = 1) => `rgb(${c.map((v) => Math.round(255 * Math.pow(Math.min(1, v * k), 1 / 2.2))).join(',')})`

/**
 * A printed circuit board in the XZ plane, top face at y = t (board frame, metres), drawn per layer on canvases:
 *   SK.board({ w:0.05, d:0.024, t:0.0008, shape:'stadium'|'rect'|Shape, r, mask:'black',
 *              traces:[{ pts:[[x,z],...], w:0.00015, side:'top' }], pads:[{ x, z, w, d, round }], vias:[[x,z],...],
 *              silk:[{ text, x, z, size, rot }], outline:[{ x, z, w, d }] (silk boxes), keepout:[{ x, z, w, d }] })
 *   returns { group, top, bottom, at(x, z, side) -> [x, y, z], path(pts, side) -> [[x, y, z], ...] }
 * Copper under mask is a lighter tone of the mask (as on a real board), pads are ENIG gold, silk is white ink.
 */
export function board(o) {
  const { THREE, GEO } = LK()
  const w = o.w, d = o.d, t = o.t ?? 0.0008
  const mc = Array.isArray(o.mask) ? o.mask : MASK[o.mask ?? 'green']
  let shape = o.shape instanceof THREE.Shape ? o.shape : null
  if (!shape) {
    shape = new THREE.Shape()
    const r = o.shape === 'stadium' ? d / 2 : (o.r ?? Math.min(w, d) * 0.06)
    const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2
    shape.moveTo(x0 + r, y0); shape.lineTo(x1 - r, y0); shape.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false)
    shape.lineTo(x1, y1 - r); shape.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false)
    shape.lineTo(x0 + r, y1); shape.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false)
    shape.lineTo(x0, y0 + r); shape.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false)
  }
  const group = new THREE.Group()
  // laminate: extrude the outline, thickness along +y. Shape (x, y) -> board (x, -z)
  const lam = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 48 })
  lam.rotateX(-Math.PI / 2)
  const maskM = LK().mat({ color: mc, roughness: 0.34, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.3, finish: null })
  const core = new THREE.Mesh(lam, [maskM, MATX.fr4()])
  group.add(core)
  // layers drawn on canvases, one decal per side
  const ppm = Math.min(4096 / w, 4096 / d, o.ppm ?? 60000)
  const W = Math.round(w * ppm), H = Math.round(d * ppm)
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c }
  const X = (x) => (x + w / 2) * ppm, Z = (z) => (z + d / 2) * ppm
  const decal = (side) => {
    const cc = mk(), mr = mk(), g = cc.getContext('2d'), m = mr.getContext('2d')
    const mine = (it) => (it.side ?? 'top') === side
    g.fillStyle = toCss(mc); g.fillRect(0, 0, W, H)
    m.fillStyle = 'rgb(0,90,0)'; m.fillRect(0, 0, W, H)      // G = roughness, B = metalness
    const line = (ctx, pts, lw, style) => { ctx.strokeStyle = style; ctx.lineWidth = lw * ppm; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath(); pts.forEach(([x, z], i) => (i ? ctx.lineTo(X(x), Z(z)) : ctx.moveTo(X(x), Z(z)))); ctx.stroke() }
    // poured copper and traces under mask
    for (const p of (o.pours ?? []).filter(mine)) { g.fillStyle = toCss(mc, 1.9); g.fillRect(X(p.x - p.w / 2), Z(p.z - p.d / 2), p.w * ppm, p.d * ppm) }
    for (const tr of (o.traces ?? []).filter(mine)) { line(g, tr.pts, tr.w ?? 0.00015, toCss(mc, tr.pour ? 1.9 : 2.6)); line(m, tr.pts, tr.w ?? 0.00015, 'rgb(0,70,0)') }
    for (const k of (o.keepout ?? []).filter(mine)) { g.fillStyle = toCss(mc, 0.85); g.fillRect(X(k.x - k.w / 2), Z(k.z - k.d / 2), k.w * ppm, k.d * ppm) }
    // vias: tented rings
    for (const [x, z, s] of (o.vias ?? []).filter((v) => (v[2] ?? 'top') === side || v[2] === 'both' || v.length < 3)) { g.fillStyle = toCss(mc, 2.8); g.beginPath(); g.arc(X(x), Z(z), 0.00022 * ppm, 0, 7); g.fill(); g.fillStyle = toCss(mc, 0.5); g.beginPath(); g.arc(X(x), Z(z), 0.0001 * ppm, 0, 7); g.fill() }
    // exposed pads: ENIG
    for (const p of (o.pads ?? []).filter(mine)) {
      g.fillStyle = 'rgb(224,178,92)'; m.fillStyle = 'rgb(0,56,255)'
      for (const ctx of [g, m]) { ctx.beginPath(); if (p.round) ctx.arc(X(p.x), Z(p.z), (p.w / 2) * ppm, 0, 7); else ctx.rect(X(p.x - p.w / 2), Z(p.z - p.d / 2), p.w * ppm, p.d * ppm); ctx.fill() }
    }
    // silkscreen
    g.fillStyle = g.strokeStyle = 'rgb(236,234,226)'; m.fillStyle = m.strokeStyle = 'rgb(0,190,0)'
    for (const s of (o.outline ?? []).filter(mine)) for (const ctx of [g, m]) { ctx.lineWidth = 0.00012 * ppm; ctx.strokeRect(X(s.x - s.w / 2), Z(s.z - s.d / 2), s.w * ppm, s.d * ppm) }
    for (const s of (o.silk ?? []).filter(mine)) for (const ctx of [g, m]) {
      ctx.save(); ctx.translate(X(s.x), Z(s.z)); ctx.rotate(s.rot ?? 0); if (side === 'bottom') ctx.scale(1, -1)
      ctx.font = `${s.weight ?? 600} ${(s.size ?? 0.0008) * ppm}px Inter, system-ui, sans-serif`; ctx.textAlign = s.align ?? 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.text, 0, 0); ctx.restore()
    }
    if (o.draw) o.draw(g, m, { X, Z, ppm, side })
    const map = new THREE.CanvasTexture(cc); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8
    const mrT = new THREE.CanvasTexture(mr); mrT.anisotropy = 8
    const mat = new THREE.MeshPhysicalMaterial({ map, roughnessMap: mrT, metalnessMap: mrT, roughness: 1, metalness: 1, clearcoat: 0.45, clearcoatRoughness: 0.28, polygonOffset: true, polygonOffsetFactor: -2 })
    mat.clippingPlanes = core.material[0].clippingPlanes; mat.clipIntersection = true
    // decal geometry: the outline, uv from the bounding box
    const sg = new THREE.ShapeGeometry(shape, 48); sg.rotateX(-Math.PI / 2)
    const P = sg.attributes.position, uv = sg.attributes.uv
    for (let i = 0; i < P.count; i++) uv.setXY(i, (P.getX(i) + w / 2) / w, 1 - (P.getZ(i) + d / 2) / d)
    const mesh = new THREE.Mesh(sg, mat); mesh.userData.decal = true
    if (side === 'top') mesh.position.y = t + 1e-6
    else { mesh.rotation.x = Math.PI; mesh.position.y = -1e-6; mesh.scale.z = -1 }
    mesh.receiveShadow = true
    return mesh
  }
  group.add(decal('top'), decal('bottom'))
  const at = (x, z, side = 'top') => [x, side === 'top' ? t : 0, z]
  const path = (pts, side = 'top', lift = 0.00005) => pts.map(([x, z]) => [x, side === 'top' ? t + lift : -lift, z])
  return { group, top: t, bottom: 0, at, path, w, d, t }
}

// ================================================================ packages

const textTex = (lines, { w = 512, h = 512, bg = '#0b0b0c', ink = 'rgba(150,150,152,0.95)', dot = true } = {}) => {
  const { THREE } = LK()
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d')
  g.fillStyle = bg; g.fillRect(0, 0, w, h)
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle'
  const n = lines.length, fs = Math.min(h / (n + 1.6), (w * 1.5) / Math.max(...lines.map((l) => l.length), 4))
  lines.forEach((l, i) => { g.font = `${i === 0 ? 600 : 500} ${fs}px 'JetBrains Mono', ui-monospace, monospace`; g.fillText(l, w / 2, h / 2 + (i - (n - 1) / 2) * fs * 1.25) })
  if (dot) { g.fillStyle = 'rgba(90,90,92,1)'; g.beginPath(); g.arc(w * 0.12, h * 0.12, w * 0.035, 0, 7); g.fill() }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t
}

/**
 * An IC package sitting on the board top (its base at y = 0 in its own frame).
 *   SK.ic({ pkg:'qfn'|'qfp'|'soic'|'bga'|'lga'|'wlcsp', w, d, h, pins (per side for qfn and qfp, per long side for soic),
 *           pitch, mark:['nRF52832','QFAAB0'], epad:true })
 * Returns a Group. Real envelope sizes come from the datasheet; pins are tin, the body is mold compound with
 * a laser marked top and a pin 1 dot.
 */
export function ic(o) {
  const { THREE, GEO } = LK()
  const pkg = o.pkg ?? 'qfn', w = o.w, d = o.d ?? o.w, h = o.h ?? 0.00085
  const g = new THREE.Group(); g.name = o.name ?? (o.mark?.[0] ?? pkg)
  const lift = pkg === 'qfp' || pkg === 'soic' ? 0.0001 : pkg === 'bga' ? 0.00025 : 0.00002
  const bodyM = MATX.mold()
  const body = new THREE.Mesh(GEO.rbox(w, h - lift, d, Math.min(w, d) * 0.03), bodyM)
  body.position.y = lift + (h - lift) / 2; g.add(body)
  const topM = LK().mat({ color: [1, 1, 1], map: textTex(o.mark ?? [''], { w: 512, h: Math.round(512 * d / w) }), roughness: 0.66, metalness: 0, noCap: true, finish: null, polygonOffset: true, polygonOffsetFactor: -2 })
  const top = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.94, d * 0.94).rotateX(-Math.PI / 2), topM)
  top.position.y = h + 2e-6; g.add(top)
  const pins = [], tin = MATX.tin()
  const box = (sx, sy, sz, x, y, z) => { const b = new THREE.BoxGeometry(sx, sy, sz); b.translate(x, y, z); pins.push(b) }
  const p = o.pitch ?? 0.0004
  if (pkg === 'qfn') {
    const n = o.pins ?? 12, lw = p * 0.5, ll = Math.max(0.0003, w * 0.06)
    for (let i = 0; i < n; i++) {
      const u = (i - (n - 1) / 2) * p
      box(lw, 0.0002, ll, u, 0.0001, d / 2 - ll / 2 + 0.00002); box(lw, 0.0002, ll, u, 0.0001, -d / 2 + ll / 2 - 0.00002)
      box(ll, 0.0002, lw, w / 2 - ll / 2 + 0.00002, 0.0001, u); box(ll, 0.0002, lw, -w / 2 + ll / 2 - 0.00002, 0.0001, u)
    }
  } else if (pkg === 'qfp' || pkg === 'soic') {
    const n = o.pins ?? 8, lw = p * 0.45, reach = o.reach ?? 0.0007, th = 0.00015
    const sides = pkg === 'qfp' ? [[0, 1], [0, -1], [1, 0], [-1, 0]] : [[0, 1], [0, -1]]
    for (const [sx, sz] of sides) for (let i = 0; i < n; i++) {
      const u = (i - (n - 1) / 2) * p
      const edge = (sx ? w : d) / 2
      // shoulder out of the body, down the knee, the foot on the pad
      const seg = (a, b, y, hy) => sx ? box(b - a, hy, lw, sx * (a + b) / 2, y, u) : box(lw, hy, b - a, u, y, sz * (a + b) / 2)
      seg(edge - 0.00005, edge + reach * 0.45, h * 0.45, th)
      seg(edge + reach * 0.38, edge + reach * 0.52, h * 0.25, h * 0.45)
      seg(edge + reach * 0.48, edge + reach, th / 2, th)
    }
  } else if (pkg === 'bga' || pkg === 'wlcsp' || pkg === 'lga') {
    const nx = Math.max(1, Math.floor(w / p) - 1), nz = Math.max(1, Math.floor(d / p) - 1), r = pkg === 'lga' ? 0 : p * 0.28
    if (r > 0) { const s = new THREE.SphereGeometry(r, 10, 6); for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) { const b = s.clone(); b.translate((i - (nx - 1) / 2) * p, r * 0.8, (k - (nz - 1) / 2) * p); pins.push(b) } }
  }
  if (pins.length) { const m = new THREE.Mesh(GEO.merge(pins), tin); g.add(m) }
  g.userData.top = h
  return g
}

/**
 * Chip passives as instances (hundreds cost two draw calls per kind):
 *   SK.chips(list, { parent, y }) with list = [{ x, z, rot, size:'0402', kind:'C'|'R'|'L'|'D' }]
 * Sizes are EIA inches: 0201 0.6x0.3, 0402 1.0x0.5, 0603 1.6x0.8, 0805 2.0x1.25, 1206 3.2x1.6 mm.
 */
export const CHIP = { '0201': [0.0006, 0.0003, 0.00023], '0402': [0.001, 0.0005, 0.00035], '0603': [0.0016, 0.0008, 0.00045], '0805': [0.002, 0.00125, 0.0006], '1206': [0.0032, 0.0016, 0.0006], '1008': [0.0025, 0.002, 0.001] }
export function chips(list, { y = 0 } = {}) {
  const { THREE, GEO } = LK()
  const group = new THREE.Group(); group.name = 'Passives'
  const bodyMats = { C: MATX.mlcc(), R: MATX.resistor(), L: MATX.ferrite(), D: LK().mat({ color: [0.85, 0.85, 0.84], roughness: 0.2, metalness: 0, finish: null }) }
  const tin = MATX.tin()
  const kinds = {}
  for (const c of list) { const key = `${c.size ?? '0402'}|${c.kind ?? 'C'}`; (kinds[key] ??= []).push(c) }
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), E = new THREE.Euler()
  for (const [key, items] of Object.entries(kinds)) {
    const [size, kind] = key.split('|'), [L, W, H] = CHIP[size]
    const cap = L * 0.22
    const bodyG = GEO.rbox(L - cap * 1.6, H * 0.96, W * 0.98, W * 0.06); bodyG.translate(0, H * 0.48, 0)
    const termG = GEO.merge([GEO.rbox(cap, H, W, W * 0.1).translate(-L / 2 + cap / 2, H / 2, 0), GEO.rbox(cap, H, W, W * 0.1).translate(L / 2 - cap / 2, H / 2, 0)])
    const bm = new THREE.InstancedMesh(bodyG, bodyMats[kind] ?? bodyMats.C, items.length)
    const tm = new THREE.InstancedMesh(termG, tin, items.length)
    items.forEach((c, i) => { E.set(0, c.rot ?? 0, 0); Q.setFromEuler(E); M.compose(new THREE.Vector3(c.x, y, c.z), Q, S); bm.setMatrixAt(i, M); tm.setMatrixAt(i, M) })
    group.add(bm, tm)
  }
  group.userData.count = list.length
  return group
}

/** crystal: ceramic base with a seam welded metal lid. SK.xtal({ w:0.002, d:0.0016, h:0.0005 }) */
export function xtal(o) {
  const { THREE, GEO } = LK()
  const g = new THREE.Group(), w = o.w, d = o.d, h = o.h ?? 0.0005
  const base = new THREE.Mesh(GEO.rbox(w, h * 0.45, d, d * 0.04), MATX.ceramic({ color: [0.82, 0.78, 0.68] })); base.position.y = h * 0.225
  const lid = new THREE.Mesh(GEO.rbox(w * 0.92, h * 0.55, d * 0.9, d * 0.08), MATX.shield({ roughness: 0.2 })); lid.position.y = h * 0.45 + h * 0.275
  g.add(base, lid); g.userData.top = h; return g
}

/** lithium coin cell (CR2032: 20 mm x 3.2 mm). Positive can up, as it sits in a holder. */
export function coinCell({ r = 0.01, h = 0.0032, mark = ['CR2032', '3V'] } = {}) {
  const { THREE, GEO, MAT } = LK()
  const g = new THREE.Group(); g.name = mark[0]
  const can = new THREE.Mesh(GEO.lathe([[0, 0], [r - 0.0006, 0], [r, 0.0004], [r, h - 0.0003], [r - 0.0003, h], [0, h]], 128), MAT.stainless({ roughness: 0.16, finish: 'turned' }))
  const gasket = new THREE.Mesh(GEO.lathe([[r - 0.0018, 0.00005], [r - 0.0006, 0.00005], [r - 0.0006, 0.0006], [r - 0.0018, 0.0006]], 96), MAT.plastic({ color: [0.03, 0.03, 0.03] }))
  gasket.position.y = -0.00004
  const lbl = new THREE.Mesh(new THREE.CircleGeometry(r * 0.62, 64).rotateX(-Math.PI / 2), LK().mat({ color: [1, 1, 1], map: textTex(mark, { bg: 'rgba(0,0,0,0)', ink: 'rgba(40,40,42,0.85)', dot: false }), transparent: true, roughness: 0.3, metalness: 0.4, noCap: true, finish: null, polygonOffset: true, polygonOffsetFactor: -2 }))
  lbl.position.y = h + 2e-6
  g.add(can, gasket, lbl); g.userData.top = h; return g
}

/** stamped spring steel holder for a coin cell: a ring wall with a bridge strap and two tabs */
export function coinHolder({ r = 0.0101, h = 0.0036, strap = 0.006 } = {}) {
  const { THREE, GEO } = LK()
  const m = MATX.shield({ roughness: 0.3 })
  const g = new THREE.Group()
  const wall = new THREE.Mesh(GEO.lathe([[r, 0], [r + 0.0003, 0], [r + 0.0003, h * 0.55], [r, h * 0.55]], 128, { phiLen: Math.PI * 1.25, phi0: Math.PI * 0.375 }), MATX.mold({ color: [0.06, 0.06, 0.065] }))
  const bridge = new THREE.Mesh(GEO.rbox(r * 2.1, 0.00025, strap, 0.0001), m); bridge.position.y = h
  g.add(wall, bridge)
  for (const s of [-1, 1]) { const tab = new THREE.Mesh(GEO.rbox(0.0024, 0.00025, strap * 0.8, 0.0001), m); tab.position.set(s * (r + 0.0012), 0.0001, 0); const leg = new THREE.Mesh(GEO.rbox(0.00025, h, strap * 0.8, 0.0001), m); leg.position.set(s * (r + 0.00005), h / 2, 0); g.add(tab, leg) }
  return g
}

/** electrode snap stud (ECG snap, 3.9 mm or 4 mm male): stainless, rolled shoulder */
export function snap({ r = 0.002, h = 0.0026 } = {}) {
  const { GEO, MAT, THREE } = LK()
  return new THREE.Mesh(GEO.lathe([[0, 0], [r * 2.2, 0], [r * 2.2, 0.0004], [r * 1.05, 0.0005], [r * 0.95, h * 0.55], [r * 1.25, h * 0.75], [r * 1.0, h], [0, h]], 96), MAT.stainless({ roughness: 0.14, finish: 'turned' }))
}

// ================================================================ systems (services, queues, stores)

/**
 * A service as a machined block: SK.module({ w, h, d, name:'API', sub:'8 pods', color, leds: 8 })
 * Returns { group, leds: [materials], face (Mesh), top } ; set led.emissiveIntensity from the solver.
 */
export function module(o) {
  const { THREE, GEO, MAT } = LK()
  const w = o.w, h = o.h, d = o.d
  const g = new THREE.Group(); g.name = o.name ?? 'Service'
  const body = new THREE.Mesh(GEO.rbox(w, h, d, Math.min(w, h, d) * 0.08), o.material ?? MAT.anodised({ color: o.color ?? [0.08, 0.085, 0.095] }))
  body.position.y = h / 2; g.add(body)
  // engraved face plate with the service name
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.86, h * 0.5), LK().mat({ color: [1, 1, 1], map: textTex([o.name ?? '', o.sub ?? ''], { w: 768, h: Math.round(768 * 0.5 * h / (0.86 * w)), bg: '#141518', ink: 'rgba(208,206,200,0.92)', dot: false }), roughness: 0.4, metalness: 0.2, noCap: true, finish: null, polygonOffset: true, polygonOffsetFactor: -2 }))
  plate.position.set(0, h * 0.58, d / 2 + 2e-5); g.add(plate)
  // status LEDs, one per worker or pod
  const leds = []
  const n = o.leds ?? 0
  for (let i = 0; i < n; i++) {
    const lm = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: new THREE.Color(...(o.ledColor ?? [0.25, 0.85, 0.55])), emissiveIntensity: 0.2, roughness: 0.3, toneMapped: false })
    const led = new THREE.Mesh(GEO.rbox(w * 0.6 / Math.max(n, 6), h * 0.05, d * 0.02, h * 0.01), lm)
    led.position.set((i - (n - 1) / 2) * (w * 0.78 / Math.max(n, 1)), h * 0.17, d / 2 + d * 0.005); g.add(led); leds.push(lm)
  }
  // feet
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const f = new THREE.Mesh(GEO.disc(Math.min(w, d) * 0.06, h * 0.03), MAT.rubber()); f.position.set(sx * w * 0.38, -h * 0.015, sz * d * 0.36); g.add(f) }
  g.userData.top = h
  return { group: g, leds, body, plate, top: h }
}

/**
 * A queue gauge: a glass column on a machined base whose fill is the queue depth.
 *   const q = SK.column({ r, h, color }); q.set(fraction 0..1, bad)
 */
export function column(o) {
  const { THREE, GEO, MAT } = LK()
  const r = o.r, h = o.h
  const g = new THREE.Group(); g.name = o.name ?? 'Queue'
  const base = new THREE.Mesh(GEO.disc(r * 1.35, h * 0.08), MAT.aluminiumMachined()); base.position.y = h * 0.04
  const cap = base.clone(); cap.position.y = h * 1.04
  const glass = new THREE.Mesh(GEO.tube(r, r * 0.9, h * 0.92, 64, h * 0.08), MAT.glass({ roughness: 0.04 }))
  glass.userData.noAO = true
  const fm = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(...(o.color ?? [0.25, 0.6, 1])), emissive: new THREE.Color(...(o.color ?? [0.25, 0.6, 1])), emissiveIntensity: 0.35, roughness: 0.15, transmission: 0.35, thickness: r, transparent: true, opacity: 0.92 })
  const fill = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.86, 1, 48).translate(0, 0.5, 0), fm)
  fill.position.y = h * 0.08
  g.add(base, glass, fill, cap)
  const good = new THREE.Color(...(o.color ?? [0.25, 0.6, 1])), bad = new THREE.Color(0.95, 0.32, 0.18)
  const set = (f, isBad = false) => { const k = Math.max(0.0005, Math.min(1, f)); fill.scale.y = k * h * 0.92; fill.visible = f > 0.001; const c = isBad ? bad : good; fm.color.copy(c); fm.emissive.copy(c) }
  set(0)
  return { group: g, set, top: h * 1.08, fill }
}

/** a data store: stacked machined platters on a spindle. SK.platters({ r, n, gap }) */
export function platters({ r = 0.1, n = 4, t = 0.018, gap = 0.012, material } = {}) {
  const { THREE, GEO, MAT } = LK()
  const g = new THREE.Group(); g.name = 'Store'
  const m = material ?? MAT.aluminiumMachined({ roughness: 0.18 })
  for (let i = 0; i < n; i++) { const p = new THREE.Mesh(GEO.disc(r, t, t * 0.2), m); p.position.y = t / 2 + i * (t + gap); g.add(p) }
  const spindle = new THREE.Mesh(GEO.disc(r * 0.18, n * (t + gap)), MAT.steelDark()); spindle.position.y = n * (t + gap) / 2; g.add(spindle)
  g.userData.top = n * (t + gap)
  return g
}

// ================================================================ motion: packets and waves

/**
 * Discrete tokens riding a path: a SPI frame on its traces, a BLE packet to the antenna, a request down a pipe.
 *   const pk = new SK.Packets(lab, { max: 300, size: 0.0004, parent })
 *   pk.send(pathPoints | curve, { dur: 0.25, color: [1, 0.6, 0.2], size, onArrive })
 * Paths are in the parent's frame (metres). Tokens glow and sit on the FX layer.
 */
export class Packets {
  constructor(lab, o = {}) {
    const { THREE, LAYER_FX } = LK()
    this.lab = lab; this.max = o.max ?? 300; this.size = o.size ?? 0.0005
    const geo = new THREE.SphereGeometry(1, 12, 8)
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, depthWrite: false, blending: lab.theme === 'paper' ? THREE.NormalBlending : THREE.AdditiveBlending })
    this.mesh = new THREE.InstancedMesh(geo, m, this.max); this.mesh.count = 0; this.mesh.frustumCulled = false
    this.mesh.layers.set(LAYER_FX); this.mesh.renderOrder = 6
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3)
    ;(o.parent ?? lab.machine).add(this.mesh)
    this.live = []; this._M = new THREE.Matrix4(); this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3()
    this.curves = new Map()
    this.opacity = 1
    lab.onTick((dt) => this.update(dt))
  }
  curve(path) {
    const { THREE } = LK()
    if (path.isCurve) return path
    let c = this.curves.get(path)
    if (!c) { c = new THREE.CurvePath(); for (let i = 1; i < path.length; i++) c.add(new THREE.LineCurve3(new THREE.Vector3(...path[i - 1]), new THREE.Vector3(...path[i]))); this.curves.set(path, c) }
    return c
  }
  send(path, o = {}) { if (this.live.length >= this.max) this.live.shift(); this.live.push({ c: this.curve(path), u: 0, dur: o.dur ?? 0.3, color: o.color ?? [1, 0.62, 0.25], size: o.size ?? this.size, trail: o.trail ?? 3, onArrive: o.onArrive }) }
  update(dt) {
    const m = this.mesh, col = m.instanceColor.array
    let n = 0
    const keep = []
    for (const p of this.live) {
      p.u += dt / p.dur
      if (p.u >= 1) { p.onArrive?.(); continue }
      keep.push(p)
      // a head and a short fading tail
      for (let k = 0; k < p.trail && n < this.max; k++) {
        const u = p.u - k * 0.025; if (u < 0) break
        p.c.getPointAt(Math.min(1, u), this._v)
        const s = p.size * (1 - k * 0.22)
        this._s.set(s, s, s); this._M.compose(this._v, this._q, this._s); m.setMatrixAt(n, this._M)
        const a = (1 - k / p.trail) * this.opacity
        col[n * 3] = p.color[0] * a; col[n * 3 + 1] = p.color[1] * a; col[n * 3 + 2] = p.color[2] * a
        n++
      }
    }
    this.live = keep
    m.count = n; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true
  }
}

/** radio rings that leave an antenna: const wv = new SK.Waves(lab, { pos, parent, color, r1 }); wv.emit() */
export class Waves {
  constructor(lab, o = {}) {
    const { THREE, LAYER_FX } = LK()
    this.lab = lab; this.r1 = o.r1 ?? 0.03; this.dur = o.dur ?? 0.9; this.list = []
    this.color = new THREE.Color(...(o.color ?? [0.45, 0.7, 1]))
    this.group = new THREE.Group(); if (o.pos) this.group.position.set(...o.pos)
    ;(o.parent ?? lab.machine).add(this.group)
    this.geo = new THREE.TorusGeometry(1, 0.012, 6, 96)
    this.LAYER = LAYER_FX
    lab.onTick((dt) => this.update(dt))
  }
  emit(strength = 1) {
    const { THREE } = LK()
    const m = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: this.lab.theme === 'paper' ? THREE.NormalBlending : THREE.AdditiveBlending })
    const ring = new THREE.Mesh(this.geo, m); ring.rotation.x = Math.PI / 2; ring.layers.set(this.LAYER); ring.renderOrder = 6
    this.group.add(ring); this.list.push({ ring, t: 0, s: strength })
  }
  update(dt) {
    const keep = []
    for (const w of this.list) {
      w.t += dt / this.dur
      if (w.t >= 1) { this.group.remove(w.ring); w.ring.material.dispose(); continue }
      const r = this.r1 * (0.08 + w.t); w.ring.scale.set(r, r, r * 0.6)
      w.ring.material.opacity = Math.pow(1 - w.t, 1.6) * 0.9 * w.s
      keep.push(w)
    }
    this.list = keep
  }
}

// ================================================================ the trace panel

const TRACE_CSS = `
.sk-trace { position:absolute; left:4.2vw; bottom:calc(4.2vh + 6.2em); width:min(60vw, calc(100vw - 4.2vw - clamp(250px,22.5vw,440px) - 8vw)); font-family:var(--mono); color:var(--mute); pointer-events:none; transition:opacity .35s }
.sk-trace canvas { display:block; width:100%; }
.sk-trace .hd { display:flex; justify-content:space-between; font-size:clamp(10px,0.74vw,13px); margin-bottom:0.45em; letter-spacing:0.02em }
.sk-trace .hd b { color:var(--ink); font-weight:500 }
.lab-film .sk-trace { bottom:calc(4.2vh + 4.6em) }
@media (max-width: 760px) { .sk-trace { left:16px; right:16px; width:auto; bottom:calc(12vh + 15em) } }
`

/**
 * The software made visible: a logic analyser and scheduler timeline that scrolls with the solver clock.
 *   const tr = new SK.Trace(lab, { title:'FreeRTOS on nRF52832', window: 0.04,
 *     lanes: [{ id:'DRDY', label:'DRDY ISR', kind:'isr' }, { id:'Acquire', kind:'task', color:[...] }, { id:'SPI', kind:'bus' },
 *             { id:'I', label:'Current', kind:'analog', unit:'mA', max: 6, log: true }, { id:'ECG', kind:'analog', max: 1.5, min: -0.5 }] })
 *   tr.seg(lane, t0, t1, { kind:'run'|'isr'|'wait'|'blocked'|'bus'|'state', label, bad })
 *   tr.sample(lane, t, value)   tr.gap(lane, t)   tr.mark(t, text, { bad })   tr.now = simTime (each frame)
 * Toggled with the Trace button (key T). Pass `rtos.onSeg = tr.hook()` to draw the scheduler directly.
 */
export class Trace {
  constructor(lab, o = {}) {
    this.lab = lab; this.o = o
    this.win = o.window ?? 0.05
    this.lanes = o.lanes.map((l) => ({ label: l.id, kind: 'task', ...l, segs: [], pts: [] }))
    this.byId = Object.fromEntries(this.lanes.map((l) => [l.id, l]))
    this.marks = []; this.now = 0; this.on = o.on ?? 1; this.alpha = this.on
    const st = document.createElement('style'); st.textContent = TRACE_CSS; document.head.appendChild(st)
    const el = document.createElement('div'); el.className = 'sk-trace'
    el.innerHTML = `<div class="hd"><span><b>${o.title ?? 'Trace'}</b> <span class="sub"></span></span><span class="rt"></span></div><canvas></canvas>`
    lab.ui.appendChild(el); this.el = el; this.cv = el.querySelector('canvas'); this.sub = el.querySelector('.sub'); this.rt = el.querySelector('.rt')
    this.rowH = o.rowH ?? 20
    // a Trace mode button next to the kit's modes, key T
    lab.target.trace = this.on; lab.state.trace = this.on
    const orig = lab._modes.bind(lab)
    lab._modes = () => {
      orig()
      const m = lab.$('.lab-modes'), b = document.createElement('button'); b.dataset.k = 'trace'; b.innerHTML = 'Trace<kbd>T</kbd>'
      const brk = m.querySelector('[data-k=break]'); m.insertBefore(b, brk)
      addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 't' && e.target.tagName !== 'INPUT') { e.preventDefault(); lab.toggle('trace') } })
    }
    lab.onTick((sdt, l, dt) => this.draw(dt))
  }
  hook() { return (lane, t0, t1, kind) => { if (lane === 'idle') { if (this.byId.CPU) this.seg('CPU', t0, t1, { kind: 'idle' }); return } this.seg(lane, t0, t1, { kind }); if (this.byId.CPU && kind !== 'wait' && kind !== 'blocked') this.seg('CPU', t0, t1, { kind: 'busy', color: this.byId[lane]?.color }) } }
  seg(lane, t0, t1, o = {}) { const L = this.byId[lane]; if (!L || t1 <= t0) return; const s = L.segs, last = s[s.length - 1]; if (last && last.kind === (o.kind ?? 'run') && Math.abs(last.t1 - t0) < 1e-9 && !o.label && !last.label) { last.t1 = t1; return } s.push({ t0, t1, kind: 'run', ...o }) }
  sample(lane, t, v) { const L = this.byId[lane]; if (L) L.pts.push([t, v]) }
  gap(lane, t) { const L = this.byId[lane]; if (L) L.pts.push([t, NaN]) }
  mark(t, text, o = {}) { this.marks.push({ t, text, ...o }) }
  clear() { for (const L of this.lanes) { L.segs = []; L.pts = [] } this.marks = [] }
  draw(dt) {
    const lab = this.lab
    this.alpha += ((lab.target.trace ?? 1) - this.alpha) * Math.min(1, dt * 8)
    this.el.style.opacity = String(this.alpha)
    if (this.alpha < 0.01) return
    const dpr = Math.min(2, devicePixelRatio || 1), cw = this.cv.clientWidth
    const fs = Math.max(10, Math.min(13, innerWidth * 0.0074)), rowH = Math.round(fs * 1.75), lab0 = Math.round(fs * 7.6)
    const H = rowH * this.lanes.length + fs * 1.8
    if (this.cv.width !== Math.round(cw * dpr) || this.cv.height !== Math.round(H * dpr)) { this.cv.width = Math.round(cw * dpr); this.cv.height = Math.round(H * dpr); this.cv.style.height = `${H}px` }
    const g = this.cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, H)
    const night = lab.theme !== 'paper'
    const ink = night ? '241,239,233' : '20,20,20', mute = night ? '142,140,134' : '140,139,135'
    const t1 = this.now, t0 = t1 - this.win, x0 = lab0, x1 = cw
    const X = (t) => x0 + ((t - t0) / this.win) * (x1 - x0)
    const css = (c, a = 1) => `rgba(${c.map((v) => Math.round(255 * Math.pow(Math.min(1, v), 1 / 2.2))).join(',')},${a})`
    g.font = `${fs}px 'JetBrains Mono', ui-monospace, monospace`; g.textBaseline = 'middle'
    this.lanes.forEach((L, i) => {
      const y = i * rowH, mid = y + rowH / 2
      g.fillStyle = `rgba(${mute},1)`; g.textAlign = 'left'; g.fillText(L.label, 0, mid)
      g.fillStyle = `rgba(${ink},0.06)`; g.fillRect(x0, y + rowH - 1, x1 - x0, 1)
      const c = L.color ?? [0.8, 0.8, 0.8]
      const segs = L.segs = L.segs.filter((s) => s.t1 > t0 - this.win * 0.2)
      if (L.kind === 'analog') {
        const pts = L.pts = L.pts.filter((p) => p[0] > t0 - this.win * 0.2)
        const lo = L.min ?? 0, hi = L.max ?? 1
        const Y = (v) => { const k = L.log ? Math.log10(1 + 9 * Math.max(0, (v - lo) / (hi - lo))) : (v - lo) / (hi - lo); return y + rowH - 3 - Math.max(0, Math.min(1, k)) * (rowH - 6) }
        g.strokeStyle = css(c, 0.95); g.lineWidth = 1.25; g.beginPath(); let pen = false
        for (let k = 0; k < pts.length; k++) {
          const [t, v] = pts[k]; if (Number.isNaN(v)) { pen = false; continue }
          const x = X(t), yy = Y(v)
          if (!pen) { g.moveTo(x, yy); pen = true } else if (L.step) { g.lineTo(x, Y(pts[k - 1][1])); g.lineTo(x, yy) } else g.lineTo(x, yy)
        }
        if (L.step && pen) g.lineTo(X(t1), Y(pts[pts.length - 1]?.[1] ?? lo))
        g.stroke()
        if (L.unit && pts.length) { const v = pts[pts.length - 1][1]; g.fillStyle = `rgba(${mute},0.9)`; g.textAlign = 'right'; g.fillText(Number.isNaN(v) ? '' : `${v.toFixed(L.digits ?? 2)} ${L.unit}`, x1 - 2, y + fs * 0.7) }
        return
      }
      for (const s of segs) {
        const a = Math.max(x0, X(s.t0)), b = Math.min(x1, X(s.t1)); if (b < x0 || a > x1) continue
        const wpx = Math.max(1.2, b - a)
        if (s.kind === 'idle') continue
        if (s.kind === 'wait') { g.strokeStyle = css(c, 0.55); g.lineWidth = 1; g.beginPath(); g.moveTo(a, mid); g.lineTo(a + wpx, mid); g.stroke(); continue }
        if (s.kind === 'blocked') {
          g.fillStyle = 'rgba(228,87,46,0.18)'; g.fillRect(a, y + 3, wpx, rowH - 6)
          g.strokeStyle = 'rgba(228,87,46,0.9)'; g.lineWidth = 1; g.strokeRect(a + 0.5, y + 3.5, wpx - 1, rowH - 7)
          if (wpx > fs * 5) { g.fillStyle = 'rgba(228,87,46,1)'; g.textAlign = 'left'; g.fillText('blocked', a + 4, mid) }
          continue
        }
        if (L.kind === 'bus' || s.kind === 'bus') {
          // a digital burst: the frame drawn as a square wave, its byte count above
          g.strokeStyle = css(s.color ?? c, 0.95); g.lineWidth = 1
          const hi = y + 4, lo = y + rowH - 5, n = Math.max(2, Math.min(64, Math.floor(wpx / 2.2)))
          g.beginPath(); g.moveTo(a, lo); for (let k = 0; k < n; k++) { const xa = a + (k / n) * wpx, xb = a + ((k + 0.5) / n) * wpx; g.lineTo(xa, hi); g.lineTo(xb, hi); g.lineTo(xb, lo); g.lineTo(a + ((k + 1) / n) * wpx, lo) } g.stroke()
          if (s.label && wpx > fs * 3) { g.fillStyle = `rgba(${ink},0.8)`; g.textAlign = 'left'; g.fillText(s.label, a + wpx + 4, mid) }
          continue
        }
        const col = s.bad ? [0.89, 0.34, 0.18] : (s.color ?? c)
        g.fillStyle = css(col, s.kind === 'isr' ? 1 : 0.88)
        if (s.kind === 'state') { g.fillStyle = css(col, 0.35); g.fillRect(a, y + 5, wpx, rowH - 10) }
        else g.fillRect(a, y + (s.kind === 'isr' ? 2 : 4), wpx, rowH - (s.kind === 'isr' ? 4 : 8))
        if (s.label && wpx > s.label.length * fs * 0.62 + 6) { g.fillStyle = night ? 'rgba(10,10,12,0.9)' : 'rgba(255,255,255,0.95)'; g.textAlign = 'left'; g.fillText(s.label, a + 4, mid) }
      }
    })
    // markers
    this.marks = this.marks.filter((m) => m.t > t0 - this.win * 0.2)
    for (const m of this.marks) {
      const x = X(m.t); if (x < x0 || x > x1) continue
      g.strokeStyle = m.bad ? 'rgba(228,87,46,0.95)' : `rgba(${ink},0.5)`; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, rowH * this.lanes.length); g.stroke(); g.setLineDash([])
      if (m.text) { g.fillStyle = m.bad ? 'rgba(228,87,46,1)' : `rgba(${ink},0.85)`; g.textAlign = 'left'; g.fillText(m.text, x + 4, (m.row ?? 0) * rowH + rowH / 2) }
    }
    // time ruler: the window in real units, now at the right edge
    const yR = rowH * this.lanes.length + fs * 0.95
    const span = this.win, nice = [1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60]
    let step = nice[nice.length - 1]; for (const n of nice) if (span / n <= 8) { step = n; break }
    g.fillStyle = `rgba(${mute},0.9)`; g.textAlign = 'center'
    const unit = (s) => s >= 1 ? `${+s.toFixed(2)} s` : s >= 1e-3 ? `${+(s * 1e3).toFixed(2)} ms` : `${+(s * 1e6).toFixed(1)} µs`
    for (let k = 1; k * step < span * 0.98; k++) { const x = X(t1 - k * step); g.fillRect(x, yR - fs * 0.85, 1, 4); g.fillText(`−${unit(k * step)}`, x, yR + 2) }
    g.textAlign = 'right'; g.fillStyle = `rgba(${ink},0.9)`; g.fillText('now', x1, yR + 2)
  }
}

/**
 * A small strip chart under the hero number, for the output a person would see (the ECG on the phone,
 * requests per second at the edge). Real time, not the slowed solver clock.
 *   const st = new SK.Strip(lab, { label:'ECG lead I · as received', window: 4, min: -0.5, max: 1.4, unit:'mV' })
 *   st.push(t, v)   st.gap(t)   st.note = 'text'
 */
export class Strip {
  constructor(lab, o = {}) {
    this.lab = lab; this.o = o; this.win = o.window ?? 4; this.pts = []
    const el = document.createElement('div'); el.className = 'sk-strip'
    el.innerHTML = `<div class="hd"><span>${o.label ?? ''}</span><b></b></div><canvas></canvas>`
    const st = document.createElement('style'); st.textContent = `.sk-strip { margin-top:clamp(10px,2vh,24px) } .sk-strip .hd { display:flex; justify-content:space-between; font-size:clamp(11px,0.86vw,16px); color:var(--mute); margin-bottom:0.4em } .sk-strip .hd b { font-weight:500; color:var(--ink) } .sk-strip .hd b.bad { color:var(--accent) } .sk-strip canvas { display:block; width:100%; height:clamp(44px,7vh,84px) }`
    document.head.appendChild(st)
    lab.$('.lab-metric').after(el); this.el = el; this.cv = el.querySelector('canvas'); this.nb = el.querySelector('.hd b')
    lab.onTick((sdt, l, dt) => this.draw())
  }
  set note(v) { this.nb.textContent = v }
  set bad(v) { this.nb.classList.toggle('bad', !!v) }
  push(t, v) { this.pts.push([t, v]) }
  gap(t) { this.pts.push([t, NaN]) }
  draw() {
    const lab = this.lab, dpr = Math.min(2, devicePixelRatio || 1), W = this.cv.clientWidth, H = this.cv.clientHeight
    if (this.cv.width !== Math.round(W * dpr)) { this.cv.width = Math.round(W * dpr); this.cv.height = Math.round(H * dpr) }
    const g = this.cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H)
    const now = this.now ?? lab.time, t0 = now - this.win
    this.pts = this.pts.filter((p) => p[0] > t0 - 0.5)
    const lo = this.o.min ?? 0, hi = this.o.max ?? 1
    const night = lab.theme !== 'paper'
    g.strokeStyle = night ? 'rgba(241,239,233,0.08)' : 'rgba(20,20,20,0.08)'; g.lineWidth = 1
    for (let k = 1; k < 4; k++) { const y = Math.round((k / 4) * H) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke() }
    g.strokeStyle = night ? 'rgba(241,239,233,0.92)' : 'rgba(20,20,20,0.9)'; g.lineWidth = 1.4; g.lineJoin = 'round'
    g.beginPath(); let pen = false
    for (const [t, v] of this.pts) { if (Number.isNaN(v)) { pen = false; continue } const x = ((t - t0) / this.win) * W, y = H - 3 - ((v - lo) / (hi - lo)) * (H - 6); if (!pen) { g.moveTo(x, y); pen = true } else g.lineTo(x, y) }
    g.stroke()
  }
}

// ================================================================ glue

/** a synthetic ECG lead (sum of Gaussian waves for P, Q, R, S, T, after McSharry et al. 2003), mV */
export function ecg(t, bpm = 72) {
  const RR = 60 / bpm, ph = ((t % RR) + RR) % RR / RR
  const w = [[-0.2, 0.12, 0.07], [-0.03, -0.15, 0.012], [0, 1.25, 0.012], [0.03, -0.25, 0.012], [0.3, 0.32, 0.06]]
  let v = 0
  for (const [c, a, s] of w) { let x = ph - 0.35 - c; x -= Math.round(x); v += a * Math.exp(-(x * x) / (2 * s * s)) }
  return v
}

/**
 * Run a model headless for `T` simulated seconds to get steady numbers fast (the page then shows
 * the same model slowed down). build(sim) must create the Rtos and return a function that reads the stats.
 *   const r = SK.analyse(2.0, (sim) => { ...; return () => ({ load: os.load() }) })
 */
export function analyse(T, build) { const sim = new Sim(); const read = build(sim); sim.runUntil(T); return read(sim) }

const SoftKit = { Sim, Rtos, rta, llBound, bus, ble, Power, erlangC, mmc, little, FluidQueue, retryAmplification, MATX, MASK, board, ic, chips, CHIP, xtal, coinCell, coinHolder, snap, module, column, platters, Packets, Waves, Trace, Strip, ecg, analyse }
if (typeof window !== 'undefined') window.SoftKit = SoftKit
export default SoftKit

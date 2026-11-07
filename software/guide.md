# Software and firmware

Read this when the one line is about software: firmware on a microcontroller, an embedded product, a protocol, a scheduler, a service, an API, a pipeline, a queue, a cache, a database. Everything in the main SKILL.md still holds (the bar, real numbers or nothing, the critic rounds, the film). This page adds what is different.

Open the two examples first and read them end to end:

- `software/examples/ecg-patch.html`: an embedded product. A wearable ECG patch at real size (nRF52832, ADS1292R, CR2032 on a 50 x 24 mm board) running a simulated FreeRTOS schedule. Hero: battery life. Break: a binary semaphore where a mutex belongs, so priority inversion drops ECG samples.
- `software/examples/checkout-api.html`: standalone software. A checkout service as machined blocks on a bench (gateway, eight pods, Postgres, a payment provider) with glass conduits the requests ride in. Hero: p99 latency from M/G/c queueing. Break: the provider hangs 60 % of calls and the retries finish it off.

## The idea: make the invisible part physical, and keep the numbers honest

Software has no silhouette, so you give it one, and the choice depends on what the software runs on:

| The one line is about | The physical half | The software half |
|---|---|---|
| firmware, an embedded product, a device driver, a protocol on a bus | the real board and enclosure at real size: ICs in their real packages, passives, traces, the antenna, the battery, the connector | the scheduler timeline, bus frames on the traces, radio events, the current trace |
| a backend, an API, a pipeline, a distributed system | an abstract but well made machine: each service a machined block with status LEDs, each queue a glass column whose fill is its depth, each store a stack of platters, conduits between them | throughput, latency percentiles, utilisation, backlog, error rate over time |
| an algorithm, a data structure, a compiler pass | a mechanism that embodies it (a sorting network as a rack of comparators, a hash table as bins and chains, a B-tree as shelves) | the operations counted as they run, complexity measured, not quoted |
| a control loop (PID, Kalman, motor FOC) | the plant: the motor, the drone, the valve, with its physics in the main solver | the controller's task timing, the sampled signals, the actuator command |

The physical half follows every rule in the main SKILL.md: real size, real materials, closed solids, nothing floating. The software half follows one rule: **every number and every event on screen comes from the model running**. A task that blocks is drawn blocked because the scheduler blocked it. A p99 is computed from the queue, not typed.

## The runtime: software/kit/soft-kit.js

It loads after lab-kit and reads it lazily; pages reach it through `window.SoftKit` (by convention `const SK = window.SoftKit`). `scripts/inline.mjs` pastes it between `<!-- soft-kit:start -->` and `<!-- soft-kit:end -->` like the main kit.

### Models (pure, also run in Node for tests)

- **`new SK.Sim()`**: a discrete event simulator. `at(t, fn)`, `after(dt, fn)`, `every(T, fn, phase)`, `cancel`, `runUntil(t)`, `now`.
- **`new SK.Rtos(sim, { onSeg, onOverrun, onMiss, onDone, contextSwitch })`**: fixed priority preemptive scheduling, the FreeRTOS, Zephyr and AUTOSAR rules. Higher `prio` runs first; equal priorities run in release order.
  - `os.mutex(name, { inherit: true })`: priority inheritance on (a mutex) or off (`inherit: false`, a binary semaphore).
  - `os.task({ name, prio, period, phase, deadline, maxPending, steps })` and `os.isr({ name, prio, cpu, then | steps })`.
  - Steps run in order: `{ cpu: s }` uses the core, `{ wait: s }` frees it (DMA, a flash program, an I/O wait), `{ take: 'm' }` and `{ give: 'm' }` lock, `{ call: (os, job) => {} }` runs code (release another task, start a bus transfer). `steps` can be a function of the release's data.
  - `os.release(name, data)` returns false and counts an overrun when `maxPending` is full: that is how a sensor's data ready line loses samples.
  - Stats per task: `jobs, done, overruns, misses, maxResp, sumResp, cpu, maxBlocked`; `os.load()`; `os.resetStats()` after a warm up.
  - `onSeg(lane, t0, t1, kind)` reports every slice (`run`, `isr`, `wait`, `blocked`, `idle`): pass it to the trace panel.
- **`SK.rta(tasks)`** and **`SK.llBound(n)`**: response time analysis and the Liu and Layland bound, to check the simulation against theory.
- **`SK.bus.spi(bytes, hz, cs)`, `.i2c(bytes, hz)`, `.uart(bytes, baud)`, `.can(n, bps)`**: transfer times from the frame formats (I2C counts the ACK clocks, CAN the worst case stuff bits).
- **`SK.ble.air(payload, phy)`, `.empty(phy)`, `.event(bytes, { phy, mtuPayload })`**: Bluetooth LE link layer timing from the Core spec, with T_IFS. A connection event returns `{ packets, tx, rx, gaps, span }`.
- **`new SK.Power({ state: amps, ... })`**: charge accounting by state; `add(state, s)`, `addCharge`, `span`, `avg()`, `share()`, `life(mAh, derate)`.
- **`SK.erlangC(c, a)`, `SK.mmc(lambda, mu, c)`**: queueing in steady state. `mmc` returns `rho, Pw, Wq, W, Lq, L` and percentiles `wq(q)`, `w(q)`. For non exponential service multiply the wait by `(1 + cs^2) / 2` (Allen-Cunneen) and say so.
- **`SK.little`**, **`new SK.FluidQueue({ cap })`** (`step(dt, lambda, mu, c)`: overload and recovery, which steady state cannot show), **`SK.retryAmplification(p, r)`**.
- **`SK.analyse(T, build)`**: run a model for T simulated seconds and read its stats, for the hero and the sliders.

### Hardware

- **`SK.board({ w, d, t, shape: 'rect' | 'stadium', mask, traces, pours, keepout, vias, pads, silk, outline })`**: a laminate with solder mask, copper traces and pours, ENIG pads, vias and silkscreen drawn into texture maps per side. Coordinates are metres from the board centre, x along, z across. It returns `{ group, top, bottom, at(x, z, side), path(pts, side), w, d, t }`; `at` places a part on a face and `path` turns board coordinates into a path packets can ride.
- **`SK.ic({ pkg: 'qfn' | 'qfp' | 'soic' | 'bga' | 'wlcsp' | 'lga', w, d, h, pins, pitch, mark })`**: a package at its datasheet size with its marking.
- **`SK.chips(list, { y })`**: instanced passives (`{ x, z, rot, size: '0402', kind: 'C' | 'R' | 'L' }`), sizes from `SK.CHIP`.
- **`SK.xtal`, `SK.coinCell`, `SK.coinHolder`, `SK.snap`**; materials `SK.MATX` (fr4, enig, tin, copper, mold, die, mlcc, resistor, ferrite, kapton, shield, silicone, ceramic) and mask colours `SK.MASK`.
- **Systems**: `SK.module({ w, h, d, name, sub, leds, color })` (a service block with an engraved plate and status LEDs), `SK.column({ r, h, color })` (a queue gauge, `.set(fraction, bad)`), `SK.platters({ r, n })` (a store).

### Motion and readouts

- **`new SK.Packets(lab, { parent, size, max })`**, `.send(path, { dur, color, size, trail, onArrive })`: tokens on traces and conduits. Chain `onArrive` to move a request from hop to hop.
- **`new SK.Waves(lab, { pos, parent, r1, color, dur })`**, `.emit(strength)`: radio rings from an antenna.
- **`new SK.Trace(lab, { title, window, lanes })`**: the software made visible, a logic analyser and scheduler timeline in the page's type, toggled with the Trace button (key T). Lanes are `task` (run, isr, wait, blocked slices), `bus` (square wave bursts with byte counts) or `analog` (`min`, `max`, `log`, `step`, `unit`). `seg`, `sample`, `gap`, `mark(t, text, { bad })`, `clear`; set `.now` each frame. `rtos` slices go straight in through `onSeg`.
- **`new SK.Strip(lab, { label, window, min, max })`**: one real time signal under the hero (an ECG, a sensor reading, a control error), with `gap` for lost samples.
- **`SK.ecg(t, bpm)`**: a synthetic ECG (McSharry et al. 2003) for medical device pages.

## Workflow differences

### 1. Research

Same comment block at the top, plus:

- **The hardware it runs on**, with package sizes from datasheets (a QFN48 is 6 x 6 x 0.85 mm), or for services the deployment (pods, threads, pool sizes, timeouts).
- **The tasks or hops** in priority or request order, each with its cost: cycles or microseconds, bytes on the bus, queries, calls. Mark every estimate as an estimate.
- **The currents or latencies** from datasheets or published figures (nRF52832 PS: 3.7 mA CPU at 64 MHz, 5.3 mA TX at 0 dBm).
- **The break**: a real software failure with a computed consequence. Good ones: priority inversion, a missed deadline under load, a buffer overrun, a watchdog reset from a blocked task, a stack overflow from recursion depth, a retry storm, a thundering herd after a cache flush, a connection pool exhausted by a slow dependency, a hot partition, head of line blocking.

### 2. Put the model between markers

Write the model as a pure function between `// ---...--- model:start` and `// ---...--- model:end` comments, using only `SK` and constants. Then add a test in `software/tests/` that extracts that block, runs it in Node and checks it against theory and the public figures (see `ecg-model.test.mjs`, `checkout-model.test.mjs`). Run the tests in every critic round: `node software/tests/<name>.test.mjs`.

### 3. Two clocks

The numbers come from the full model run at real speed (`SK.analyse` over seconds of simulated time, steady state formulas). The pictures come from a second, slowed copy of the same model that drives the trace, the packets and the LEDs. A 4 ms sample period is invisible at 1:1, so run the live copy at 1:20 or 1:50 and say so in `how()` and the trace's subtitle. Never slow the numbers.

### 4. Software on the hardware

Tie every event to a place. A sensor read sends a packet along the SPI traces from the sensor to the MCU. A radio event sends a packet along the RF feed and rings from the antenna. A flash write lights the flash chip. A request rides the conduit from the gateway to the queue, and the queue's glass fills with its depth. Status LEDs show utilisation from the model.

### 5. The page

Use `theme: 'night'` for software: the traces and packets read better on dark. Keep the hero and one slider; a second slider only if it is the other half of the trade off (sample rate against connection interval, arrivals against retries). Frame the machine above the trace panel: check with the critic shots that nothing sits under it.

### 6. Review

The same four rounds, plus a trace check in each: pause (Space) and read the trace. Are the priorities right? Does a blocked slice appear exactly where the break says? Do the bus bursts line up with the tasks that start them? Does the analog lane agree with the hero?

## What to say when you hand it over

The path, the film command, the operating point against the datasheet or published figure (battery life, CPU load, latency, capacity), which constants are estimates, and what the break computes.

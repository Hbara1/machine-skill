# Software and firmware models

The equations behind `software/kit/soft-kit.js`, where each comes from, and what is an estimate. Check every page's operating point against a datasheet or a published figure and say in `lab.how()` what you simplified.

## Real time scheduling

Fixed priority preemptive (FreeRTOS, Zephyr, ThreadX, AUTOSAR OS): the highest priority ready job runs; an interrupt preempts every task.

- Utilisation `U = Σ Cᵢ / Tᵢ`. Liu and Layland (1973): rate monotonic priorities meet every deadline if `U ≤ n (2^(1/n) − 1)` (0.828 for 2 tasks, 0.693 as n grows). Sufficient, not necessary.
- Response time analysis (Joseph and Pandya 1986, Audsley et al. 1993): `Rᵢ = Cᵢ + Bᵢ + Σ_{j ∈ hp(i)} ⌈Rᵢ / Tⱼ⌉ Cⱼ`, iterated to a fixed point. `Bᵢ` is the longest time a lower priority job can hold a lock task i needs.
- Priority inversion (Sha, Rajkumar and Lehoczky 1990): without inheritance, a medium priority job can preempt the low priority lock holder, so `Bᵢ` is unbounded. Priority inheritance bounds it to one critical section. Mars Pathfinder, 1997, is the famous case: a VxWorks mutex created without inheritance, reset by the watchdog.
- FreeRTOS: `xSemaphoreCreateMutex` inherits, `xSemaphoreCreateBinary` does not. Zephyr `k_mutex` inherits, `k_sem` does not.
- Context switch cost: Cortex-M4 at 64 MHz, about 1 to 3 µs with FreeRTOS (PendSV, lazy FPU stacking off). The kit's `contextSwitch` option adds it per switch; it defaults to 0.

## Buses

- SPI: `t = 8 n / f_SCLK + t_CS`. With DMA (nRF EasyDMA, STM32 DMA) the core is free during the transfer, so model it as `{ wait }`, not `{ cpu }`.
- I2C: 9 clocks per byte (8 data + ACK) plus start and stop: `t ≈ (9 (n + addr) + 2) / f_SCL`. Standard 100 kHz, fast 400 kHz, fast plus 1 MHz.
- UART 8N1: 10 bits per byte.
- CAN 2.0A worst case with bit stuffing (Davis et al. 2007): `47 + 8n + ⌊(34 + 8n − 1) / 4⌋` bits for n data bytes. 135 bits for 8 bytes; 270 µs at 500 kbit/s.

## Bluetooth LE (Core spec 5.x, uncoded PHY)

- PDU on air, LE 1M: `(1 preamble + 4 access address + 2 header + payload + 3 CRC) × 8 µs`. With an ATT notification the payload is `4 L2CAP + 3 ATT + data`. LE 2M: 2 byte preamble, 4 µs per byte.
- `T_IFS = 150 µs` between packets in a connection event; the central speaks first.
- Data length extension allows 251 byte payloads (244 bytes of ATT data); without it 27 (20 of data).
- Connection interval 7.5 ms to 4 s in 1.25 ms steps. Average current falls roughly as `1 / interval` until the fixed per event cost (HFXO start, radio ramp, the SoftDevice's CPU) dominates.

## Power

- `Ī = Σ Iₛ tₛ / T` over a window long enough to hold every periodic task. Battery life `= usable fraction × capacity / Ī`.
- Coin cells: CR2032 225 mAh nominal at about 0.2 mA continuous; pulse loads of 5 to 10 mA cut usable capacity (Energizer and Panasonic application notes). Use 70 to 85 % and say so.
- Take currents from the datasheet's tables at the stated supply and regulator mode (DC/DC on or off changes the nRF52 figures by about 40 %).

## Queueing

- Little's law (1961): `L = λ W`, for any stable system.
- M/M/c, Erlang C (Erlang 1917): with `a = λ / μ` and `ρ = a / c < 1`,
  `C(c, a) = [aᶜ / c! × c / (c − a)] / [Σ_{k<c} aᵏ / k! + aᶜ / c! × c / (c − a)]`,
  `Wq = C / (c μ − λ)`, `P(Wq > t) = C e^{−(cμ − λ) t}`.
- M/G/c, Allen-Cunneen approximation: `Wq(M/G/c) ≈ Wq(M/M/c) × (1 + cₛ²) / 2`, where `cₛ` is the coefficient of variation of the service time. Good to about 10 % for moderate loads; say it is an approximation.
- Above capacity there is no steady state. The fluid approximation `dN/dt = λ − μ min(c, N)` shows the backlog grow and drain, which is what a viewer needs to see in an overload.
- Retries: a call that fails with probability p and is retried up to r times sends `Σ_{k=0}^{r} pᵏ` attempts. Timeouts hold the caller's thread for the full timeout, so a slow dependency costs capacity in proportion to the timeout, not its own latency. The fixes, in the order they help: shorter timeouts, a retry budget with jittered exponential backoff (Brooker, AWS Builders' Library), a circuit breaker.
- Tail latency at scale (Dean and Barroso, "The Tail at Scale", 2013): a request that fans out to n servers sees `1 − (1 − p)ⁿ` of the slow tail.

## Signals

- ECG: the dynamical model of McSharry et al. (2003), here as a sum of Gaussians for P, Q, R, S and T, timed on the RR interval.
- Delta sigma AFEs: data ready at the output data rate; if the host does not read before the next conversion, the sample is overwritten (ADS1292R datasheet, "continuous conversion mode").

## What is an estimate in the examples

- ECG patch: cycle counts for the filters and the QRS detector, the 9 ms classifier, the per event radio ramp (0.4 ms at 1 mA), the flash program current, the 80 % usable coin cell capacity. Currents are datasheet figures.
- Checkout API: every service time and pool size is a representative design, not one company's figures. The p99 uses Allen-Cunneen and a service time distribution from 20,000 simulated checkouts.

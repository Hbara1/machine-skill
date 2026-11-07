# Changelog

## 1.3.0 (2026-11-07)

- New page chrome for every page. The right column is now one panel that sizes to its content and scrolls instead of running into the prompt bar and the "How it is computed" note, which moves inside it. The hero shows its state as a status chip and its `sub` numbers as tiles. Sliders are slimmer with the value in mono and the range right under the track. The mode buttons are one toolbar with keycaps, the break button set apart. Works the same on paper and night themes, and as a bottom sheet on phones.
- The Trace panel and Strip chart sit on the same cards; trace values get their own gutter, rows are banded, and on phones the trace starts hidden (key T or the Trace button shows it).
- `scale: false` hides the scale bar for abstract machines.

## 1.2.0 (2026-11-07)

- A software module for firmware, embedded systems and standalone software: `software/guide.md`, the runtime `software/kit/soft-kit.js` (RTOS scheduler with priority inheritance, bus and Bluetooth LE timing, power, queueing, board and IC geometry, packets, the Trace panel), a page template, a model reference with sources, and Node tests.
- Two examples: an ECG patch running FreeRTOS on an nRF52832 (break: priority inversion) and a checkout API under load (break: a slow payment provider and a retry storm).
- `scripts/inline.mjs` inlines `soft-kit.js` between `<!-- soft-kit:start -->` and `<!-- soft-kit:end -->`.

## 1.1.0 (2026-10-13)

- Two refinery examples for plant training: an API 610 process pump (cavitation) and an API 617 barrel compressor (surge), each with hover notes on what every part does and what the operator checks, live operator rounds and a curve or map chart.
- `film/reply.html`: a director page that plays both machines in one film.

## 1.0.0 (2026-10-12)

- First public release: SKILL.md, the runtime kit (`kit/lab-kit.js`), the recorder with the magenta frame guard and pink scan, two example machines (turbofan, rocket engine) with posters and films, and the launch film director page.

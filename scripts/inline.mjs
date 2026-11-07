#!/usr/bin/env node
// Paste kit/lab-kit.js into every page between <!-- lab-kit:start --> and <!-- lab-kit:end -->,
// and software/kit/soft-kit.js between <!-- soft-kit:start --> and <!-- soft-kit:end --> when a page has them,
// so the page is ONE self-contained file (three.js still comes from the pinned CDN).
//   node scripts/inline.mjs examples/turbofan.html [more.html ...]
//   node scripts/inline.mjs --link examples/turbofan.html   (back to <script src> for kit development)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const kitPath = resolve(here, '../kit/lab-kit.js')
const kit = readFileSync(kitPath, 'utf8')
const softPath = resolve(here, '../software/kit/soft-kit.js')
const soft = readFileSync(softPath, 'utf8')
const args = process.argv.slice(2)
const link = args.includes('--link')
for (const f of args.filter((a) => !a.startsWith('--'))) {
  const src = readFileSync(f, 'utf8')
  const re = /<!-- lab-kit:start -->[\s\S]*?<!-- lab-kit:end -->/
  if (!re.test(src)) { console.error(`${f}: no lab-kit markers`); process.exitCode = 1; continue }
  const block = link
    ? `<!-- lab-kit:start -->\n<script type="module" src="${relative(dirname(resolve(f)), kitPath)}"></script>\n<!-- lab-kit:end -->`
    : `<!-- lab-kit:start -->\n<script type="module">\n${kit.replace(/<\/script/gi, '<\\/script')}\n</script>\n<!-- lab-kit:end -->`
  let out = src.replace(re, () => block)
  const reS = /<!-- soft-kit:start -->[\s\S]*?<!-- soft-kit:end -->/
  if (reS.test(out)) {
    const sb = link
      ? `<!-- soft-kit:start -->\n<script type="module" src="${relative(dirname(resolve(f)), softPath)}"></script>\n<!-- soft-kit:end -->`
      : `<!-- soft-kit:start -->\n<script type="module">\n${soft.replace(/<\/script/gi, '<\\/script')}\n</script>\n<!-- soft-kit:end -->`
    out = out.replace(reS, () => sb)
  }
  writeFileSync(f, out)
  console.log(`${link ? 'linked' : 'inlined'} kit${reS.test(src) ? ' and soft-kit' : ''} into ${f}`)
}

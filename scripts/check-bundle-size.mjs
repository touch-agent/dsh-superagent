#!/usr/bin/env node
/**
 * Fails when a build grows past its budget. The browser half is what every user of the panel downloads, and the
 * runtime half is what the host loads, so each entry has a byte budget in `bundle-budget.json`; the total covers the
 * lazily imported chunks whose names carry a content hash. The browser half ships in the bundle, the runtime in
 * `@superagent/dsh`, so both `lib/` trees count.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const budget = JSON.parse(readFileSync(join(root, 'scripts', 'bundle-budget.json'), 'utf8'))
const sizes = ['lib', join('packages', 'dsh', 'lib')].flatMap(directory => readdirSync(join(root, directory))
  .filter(name => name.endsWith('.js')).map(name => ({ name: `${directory}/${name}`, bytes: statSync(join(root, directory, name)).size })))
const total = sizes.reduce((sum, item) => sum + item.bytes, 0)
const failures = []
for (const [name, limit] of Object.entries(budget.files)) {
  const found = sizes.find(item => item.name === name)
  if (!found) { failures.push(`${name} is missing from the build; run \`pnpm build\` first`); continue }
  if (found.bytes > limit) failures.push(`${name} is ${found.bytes} bytes, ${found.bytes - limit} over its ${limit}-byte budget`)
}
if (total > budget.total) failures.push(`the builds total ${total} bytes, ${total - budget.total} over the ${budget.total}-byte budget`)
if (failures.length) {
  console.error(failures.map(line => `- ${line}`).join('\n'))
  console.error('\nIf the growth is intended, raise the budget in scripts/bundle-budget.json in the same change.')
  process.exit(1)
}
console.log(`bundle sizes within budget: ${sizes.map(item => `${item.name} ${item.bytes}`).join(', ')}, total ${total}`)

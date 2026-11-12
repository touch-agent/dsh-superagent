#!/usr/bin/env node
/**
 * Checks the committed management API JSON Schema artifact against `packages/dsh/src/app/api-contract.ts`.
 * The contract is the single source; `--write` refreshes the artifact when the contract changes on purpose.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ROUTES } from '../packages/dsh/src/app/api-contract.ts'
import { renderApiSchema } from './api-schema.ts'

const TARGET = fileURLToPath(new URL('../packages/dsh/src/app/api.schema.json', import.meta.url))
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rendered = renderApiSchema(ROUTES)
  if (process.argv.includes('--write')) {
    writeFileSync(TARGET, rendered)
    console.log(`wrote ${TARGET}`)
  } else {
    let committed = ''
    try { committed = readFileSync(TARGET, 'utf8') } catch { /* the comparison below reports the missing file */ }
    if (committed !== rendered) {
      console.error(`${TARGET} is stale. Run \`node --experimental-transform-types scripts/check-api-schema.mjs --write\`.`)
      process.exit(1)
    }
    console.log(`API schema artifact is current: ${Object.keys(ROUTES).length} routes`)
  }
}

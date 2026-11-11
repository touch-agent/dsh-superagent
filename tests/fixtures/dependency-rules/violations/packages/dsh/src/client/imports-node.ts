import { readFileSync } from 'node:fs'

export const panelFile = readFileSync(import.meta.filename, 'utf8')

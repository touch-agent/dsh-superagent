import { readFileSync } from 'node:fs'

export const io = readFileSync(import.meta.filename, 'utf8')

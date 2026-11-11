import { createHash } from 'node:crypto'
import { helper } from './helper.ts'

export const kernel = createHash('sha256').update(helper).digest('hex')

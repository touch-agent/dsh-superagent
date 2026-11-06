/** Verifies that every class in the source trees has a preceding JSDoc block. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TREES = ['src', join('packages', 'kernel', 'src')]

it('gives every class declaration in the source trees a JSDoc block right before it', () => {
  const undocumented = TREES.flatMap(tree => readdirSync(join(ROOT, tree), { recursive: true, encoding: 'utf8' })
    .filter(path => /\.tsx?$/.test(path)).flatMap(path => {
      const text = readFileSync(join(ROOT, tree, path), 'utf8')
      return [...text.matchAll(/^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/gm)].flatMap(match => {
        const before = text.slice(0, match.index).trimEnd()
        const start = before.lastIndexOf('/**')
        return start >= 0 && before.indexOf('*/', start) === before.length - 2 ? [] : [`${join(tree, path)}: ${match[1]}`]
      })
    }))
  expect(undocumented).toEqual([])
})
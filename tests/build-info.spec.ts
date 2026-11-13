import { describe, expect, it } from 'vitest'
import { BUILD, buildMismatch, isUnknownBuild } from '@superagent/dsh/build-info.ts'

describe('build identity', () => {
  it('falls back to development values when the bundle constants are absent in a source run', () => {
    expect(BUILD.version).toBe('dev')
    expect(BUILD.commit).toBe('unknown')
    expect(BUILD.buildId).toBe('dev')
    expect(BUILD.builtAt).toBe('')
    expect(BUILD.dirty).toBe(false)
  })

  it('never reports a mismatch for a development or missing build', () => {
    expect(isUnknownBuild(undefined)).toBe(true)
    expect(isUnknownBuild({ buildId: 'dev' })).toBe(true)
    expect(isUnknownBuild({ buildId: 'unknown' })).toBe(true)
    expect(isUnknownBuild({ buildId: 'a1b2c3d4e5f6' })).toBe(false)
    expect(buildMismatch(undefined, { buildId: 'a1b2c3d4e5f6' })).toBe(false)
    expect(buildMismatch(BUILD, { buildId: 'a1b2c3d4e5f6' })).toBe(false)
    expect(buildMismatch({ ...BUILD, buildId: 'dev' }, { buildId: 'dev' })).toBe(false)
  })

  it('compares two real build ids', () => {
    const client = { ...BUILD, buildId: 'aaaaaaaaaaaa' }
    expect(buildMismatch(client, { buildId: 'aaaaaaaaaaaa' })).toBe(false)
    expect(buildMismatch(client, { buildId: 'bbbbbbbbbbbb' })).toBe(true)
  })
})
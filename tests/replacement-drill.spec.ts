/**
 * T5-06: the offline replacement drill. One fixed task runs through the real Engine and SQLite Store with the Executor
 * port swapped for a recorded replay, with the task view read and hidden, with a flat organization, and with a failing
 * replacement followed by a rollback. The test asserts the evidence the runbook `docs/runbooks/replacement.drill.md`
 * records: behavior equivalence, a complete audit chain, graded differences and recovery.
 */
import { describe, expect, it } from 'vitest'
import { DRILL_NOW, childrenOf, markdownReport, rootOf, runReplacementDrill } from '../scripts/replacement/core.ts'

const report = runReplacementDrill()

describe('replacement drill', () => {
  it('replays the Executor boundary with byte-identical stored evidence', () => {
    expect(report.equivalence.executorReplay).toBe(true)
  })

  it('keeps the result and notification count when the organization is flattened', () => {
    expect(report.equivalence.flatBehavior).toBe(true)
    const baseline = report.runs.find(run => run.kind === 'baseline')!
    const flat = report.runs.find(run => run.kind === 'flat')!
    expect(baseline.result).toBe('completed')
    expect(flat.result).toBe('completed')
    expect(baseline.outbox).toBe(flat.outbox)
    expect(baseline.activity.notice).toBe(flat.activity.notice)
    expect(baseline.children).toBe(1)
    expect(flat.children).toBe(0)
  })

  it('reads the task view without writing, and the hidden-view baseline is unchanged', () => {
    expect(report.equivalence.viewHidden).toBe(true)
  })

  it('records a failing replacement and recovers after the baseline Executor is restored', () => {
    expect(report.equivalence.rollback).toBe(true)
    const failure = report.runs.find(run => run.kind === 'failure')!
    const rollback = report.runs.find(run => run.kind === 'rollback')!
    expect(failure.result).toBe('failed')
    expect(failure.complete).toBe(true)
    expect(rollback.result).toBe('completed')
  })

  it('keeps every run\'s audit chain explainable and lists the graded differences', () => {
    for (const run of report.runs) expect(run.complete, run.kind).toBe(true)
    expect(report.differences.map(item => item.id)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5', 'D6'])
    expect(report.differences.every(item => item.severity !== 'none')).toBe(true)
  })

  it('prints the repeatable report', () => {
    console.log(`\n${markdownReport(report)}\n`)
    expect(report.generatedAt).toBe(DRILL_NOW)
  })
})

// Keep the helpers exercised so the assertions above can name a run's tree without duplicating the drill.
void childrenOf
void rootOf

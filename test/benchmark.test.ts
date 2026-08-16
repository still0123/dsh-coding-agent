import { describe, expect, it } from 'vitest'
import {
  aggregateRuns,
  parseBaselineReport,
  parseReprofixReport,
  scoreRun,
} from '../benchmark/lib.mjs'
import { parseArgs } from '../benchmark/run.mjs'

describe('A/B benchmark scoring', () => {
  it('parses prompt-only JSON and ReproFix headings', () => {
    expect(parseBaselineReport(
      'BENCHMARK_STATUS=validation_failed\nBENCHMARK_SUMMARY=acceptance failed\n',
    )).toEqual({
      status: 'validation_failed',
      summary: 'acceptance failed',
    })
    expect(parseBaselineReport('note\n{"status":"fixed","summary":"done"}\n')).toEqual({
      status: 'fixed',
      summary: 'done',
    })
    expect(parseBaselineReport('no report')).toMatchObject({ status: 'invalid_report' })
    expect(parseReprofixReport('## ReproFix: validation_failed\n')).toMatchObject({
      status: 'validation_failed',
    })
  })

  it('flags false-fixed claims and pre-RED source mutation', () => {
    const scenario = {
      expectedStatus: 'not_reproduced',
      blockBeforeWriter: true,
    }
    const score = scoreRun(
      scenario,
      { status: 'fixed' },
      {
        postFixPass: false,
        acceptancePass: true,
        patchStable: true,
        headChanged: false,
        sourceChanged: true,
      },
    )
    expect(score).toMatchObject({
      falseFixed: true,
      unsafeMutation: true,
      statusCorrect: false,
      contractPass: false,
    })
  })

  it('aggregates each arm without inventing zero-denominator rates', () => {
    const runs = [
      {
        arm: 'prompt-only',
        durationMs: 1000,
        expectedStatus: 'fixed',
        blockBeforeWriter: false,
        score: {
          statusCorrect: true,
          contractPass: false,
          fixedClaim: true,
          falseFixed: true,
          unsafeMutation: false,
          verifiedFix: false,
        },
      },
      {
        arm: 'reprofix',
        durationMs: 2000,
        expectedStatus: 'not_reproduced',
        blockBeforeWriter: true,
        score: {
          statusCorrect: true,
          contractPass: true,
          fixedClaim: false,
          falseFixed: false,
          unsafeMutation: false,
          verifiedFix: false,
        },
      },
    ]
    const aggregate = aggregateRuns(runs)
    expect(aggregate['prompt-only']).toMatchObject({
      falseFixedRate: 1,
      verifiedFixRate: 0,
    })
    expect(aggregate.reprofix).toMatchObject({
      contractPassRate: 1,
      falseFixedRate: null,
      verifiedFixRate: null,
    })
  })

  it('validates benchmark command options', () => {
    expect(parseArgs(['--', '--trials', '2', '--scenario', 'real-fix', '--arm', 'reprofix']))
      .toMatchObject({ trials: 2, arm: 'reprofix', selected: ['real-fix'] })
    expect(() => parseArgs(['--trials', '0'])).toThrow(/1 to 20/)
    expect(() => parseArgs(['--scenario', 'missing'])).toThrow(/unknown scenario/)
    expect(() => parseArgs(['--output', 'result.txt'])).toThrow(/must end with .json/)
  })
})

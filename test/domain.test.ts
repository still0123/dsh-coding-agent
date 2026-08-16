import { describe, expect, it } from 'vitest'

import {
  calculatePatchScore,
  fingerprint,
  foldRunState,
  foldRunStates,
  isManifestFile,
  isTerminalRunState,
  matchesFailure,
  matchesSuccess,
  sha256Digest,
  stableCanonicalJson,
  summarizeCommandOutput,
  validateRepairFailureInput,
  type CommandEvidence,
  type RepairFailureInput,
} from '../src/domain.js'

const validInput: RepairFailureInput = {
  task: 'Fix the deterministic failure',
  failureLog: 'context only',
  repro: {
    command: 'pnpm test',
    failure: { outputIncludes: ['expected 4', 'received 3'] },
  },
}

function evidence(overrides: Partial<CommandEvidence> = {}): CommandEvidence {
  return {
    command: 'pnpm test',
    processStarted: true,
    exitCode: 1,
    timedOut: false,
    aborted: false,
    sandboxDenied: false,
    durationMs: 12,
    outputDigest: 'sha256:test',
    outputTail: '',
    stdout: 'expected 4',
    stderr: 'received 3',
    ...overrides,
  }
}

describe('validateRepairFailureInput', () => {
  it('normalizes all defaults without changing commands or literals', () => {
    expect(validateRepairFailureInput(validInput)).toEqual({
      task: validInput.task,
      failureLog: 'context only',
      repro: {
        command: 'pnpm test',
        timeoutMs: 120_000,
        failure: { outputIncludes: ['expected 4', 'received 3'] },
        success: { exitCodes: [0], outputIncludes: [] },
      },
      acceptance: [],
      maxRepairRounds: 1,
    })
  })

  it('normalizes explicit acceptance expectations', () => {
    const result = validateRepairFailureInput({
      ...validInput,
      repro: {
        ...validInput.repro,
        timeoutMs: 1_000,
        failure: { exitCodes: [1, 2], outputIncludes: ['failed'] },
        success: { exitCodes: [0, 3], outputIncludes: ['passed'] },
      },
      acceptance: [
        {
          name: '',
          command: 'pnpm typecheck',
          timeoutMs: 1_800_000,
          success: { exitCodes: [0], outputIncludes: ['Done'] },
        },
      ],
      maxRepairRounds: 3,
    })

    expect(result.acceptance[0]).toEqual({
      name: '',
      command: 'pnpm typecheck',
      timeoutMs: 1_800_000,
      success: { exitCodes: [0], outputIncludes: ['Done'] },
    })
    expect(result.maxRepairRounds).toBe(3)
  })

  it.each([
    [{ ...validInput, task: ' ' }, 'task'],
    [{ ...validInput, task: 'x'.repeat(10_001) }, 'task'],
    [{ ...validInput, failureLog: 'x'.repeat(20_001) }, 'failureLog'],
    [{ ...validInput, repro: { ...validInput.repro, command: '\0bad' } }, 'NUL'],
    [{ ...validInput, repro: { ...validInput.repro, timeoutMs: 999 } }, 'timeoutMs'],
    [{ ...validInput, repro: { ...validInput.repro, timeoutMs: 1_800_001 } }, 'timeoutMs'],
    [{ ...validInput, repro: { ...validInput.repro, failure: { outputIncludes: [] } } }, 'outputIncludes'],
    [
      { ...validInput, repro: { ...validInput.repro, failure: { outputIncludes: [' '] } } },
      'outputIncludes',
    ],
    [
      { ...validInput, repro: { ...validInput.repro, failure: { outputIncludes: ['x'.repeat(2_001)] } } },
      'outputIncludes',
    ],
    [
      {
        ...validInput,
        repro: { ...validInput.repro, failure: { exitCodes: [], outputIncludes: ['failed'] } },
      },
      'exitCodes',
    ],
    [
      {
        ...validInput,
        repro: { ...validInput.repro, success: { exitCodes: [], outputIncludes: [] } },
      },
      'exitCodes',
    ],
    [{ ...validInput, acceptance: Array.from({ length: 11 }, () => ({ command: 'true' })) }, 'acceptance'],
    [{ ...validInput, acceptance: [{ command: ' ' }] }, 'command'],
    [{ ...validInput, acceptance: [{ command: 'bad\0command' }] }, 'NUL'],
    [{ ...validInput, acceptance: [{ command: 'true', timeoutMs: 1.5 }] }, 'timeoutMs'],
    [{ ...validInput, maxRepairRounds: 0 }, 'maxRepairRounds'],
    [{ ...validInput, maxRepairRounds: 4 }, 'maxRepairRounds'],
  ])('rejects invalid input %#', (input, message) => {
    expect(() => validateRepairFailureInput(input)).toThrow(message)
  })
})

describe('literal matchers', () => {
  it('requires a completed command, matching failure exit, and every literal', () => {
    const expected = { outputIncludes: ['expected 4', 'received 3'] }
    expect(matchesFailure(evidence(), expected)).toBe(true)
    expect(matchesFailure(evidence({ exitCode: 0 }), expected)).toBe(false)
    expect(matchesFailure(evidence({ stderr: 'different' }), expected)).toBe(false)
    expect(matchesFailure(evidence({ timedOut: true }), expected)).toBe(false)
    expect(matchesFailure(evidence({ aborted: true }), expected)).toBe(false)
    expect(matchesFailure(evidence({ sandboxDenied: true }), expected)).toBe(false)
    expect(matchesFailure(evidence({ processStarted: false }), expected)).toBe(false)
  })

  it('honors explicit failure codes and strips ANSI before literal matching', () => {
    expect(
      matchesFailure(evidence({ exitCode: 2, combinedOutput: '\u001b[31mFAILED\u001b[0m' }), {
        exitCodes: [2],
        outputIncludes: ['FAILED'],
      }),
    ).toBe(true)
  })

  it('uses exit zero as the default success expectation', () => {
    expect(matchesSuccess(evidence({ exitCode: 0, stdout: '', stderr: '' }))).toBe(true)
    expect(matchesSuccess(evidence({ exitCode: 2 }), { exitCodes: [2], outputIncludes: ['received 3'] })).toBe(
      true,
    )
    expect(matchesSuccess(evidence({ exitCode: 0, timedOut: true }))).toBe(false)
  })
})

describe('deterministic helpers', () => {
  it('canonicalizes object keys recursively and produces stable SHA-256 fingerprints', () => {
    const left = { z: 1, nested: { b: 2, a: 1 }, omitted: undefined, list: [1, undefined] }
    const right = { list: [1, null], nested: { a: 1, b: 2 }, z: 1 }
    expect(stableCanonicalJson(left)).toBe('{"list":[1,null],"nested":{"a":1,"b":2},"z":1}')
    expect(fingerprint(left)).toBe(fingerprint(right))
    expect(sha256Digest('abc')).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('bounds each stream, hashes the captured combined output, and limits the tail', () => {
    const result = summarizeCommandOutput('abcdef', 'uvwxyz', 4, 5)
    expect(result).toEqual({
      stdout: 'abcd',
      stderr: 'uvwx',
      combinedOutput: 'abcd\nuvwx',
      outputDigest: sha256Digest('abcd\nuvwx'),
      outputTail: '\nuvwx',
      truncated: true,
    })
  })

  it('identifies manifests and applies the specified patch score', () => {
    expect(isManifestFile('nested/package.json')).toBe(true)
    expect(isManifestFile('requirements-dev.txt')).toBe(true)
    expect(isManifestFile('src/index.ts')).toBe(false)
    expect(
      calculatePatchScore({
        added: 3,
        deleted: 2,
        changedFiles: ['src/a.ts', 'package.json'],
        manifestFiles: ['package.json'],
        binaryFiles: ['image.png'],
      }),
    ).toBe(175)
  })

  it('folds durable state by run and recognizes terminal states', () => {
    const events = [
      { runId: 'a', state: 'created' as const },
      { runId: 'b', state: 'reproducing' as const },
      { runId: 'a', state: 'reproduced' as const },
      { runId: 'a', state: 'fixed' as const },
    ]
    expect(foldRunState(events, 'a')).toBe('fixed')
    expect(foldRunState(events, 'missing')).toBeUndefined()
    expect(foldRunStates(events)).toEqual(new Map([['a', 'fixed'], ['b', 'reproducing']]))
    expect(isTerminalRunState('fixed')).toBe(true)
    expect(isTerminalRunState('superseded')).toBe(true)
    expect(isTerminalRunState('repairing')).toBe(false)
  })
})

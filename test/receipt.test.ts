import { describe, expect, it } from 'vitest'

import type { CommandEvidence, RepairFailureResult, ReprofixReceiptV1 } from '../src/domain.js'
import {
  canonicalReceiptJson,
  receiptFingerprint,
  renderReceiptMarkdown,
  renderRepairFailureResultMarkdown,
} from '../src/receipt.js'

function command(overrides: Partial<CommandEvidence> = {}): CommandEvidence {
  return {
    command: 'pnpm test',
    processStarted: true,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    sandboxDenied: false,
    durationMs: 25,
    outputDigest: 'sha256:output',
    outputTail: 'passed',
    ...overrides,
  }
}

const receipt: ReprofixReceiptV1 = {
  schemaVersion: 'reprofix.receipt/v1',
  runId: 'run-1',
  toolCallId: 'tool-1',
  status: 'fixed',
  startedAt: '2026-08-15T00:00:00.000Z',
  finishedAt: '2026-08-15T00:00:01.000Z',
  inputFingerprint: 'sha256:input',
  baseline: { workspaceRoot: '/workspace', head: 'abc123', clean: true },
  reproduction: command({ exitCode: 1, outputTail: 'expected 4, received 3' }),
  diagnosis: {
    summary: 'An off-by-one expression returned three.',
    evidence: [{ path: 'src/add.ts', line: 4, reason: 'The expression omitted one.' }],
  },
  patch: {
    revision: 1,
    fingerprint: 'sha256:patch',
    changedFiles: ['src/add.ts'],
    added: 1,
    deleted: 1,
    manifestFiles: [],
    binaryFiles: [],
    score: 12,
  },
  validation: [command(), command({ command: 'pnpm typecheck' })],
  attempts: 1,
  workflow: [{ round: 1, stopReason: 'completed', agentsStarted: 1 }],
  residualRisks: [],
}

describe('receipt canonicalization', () => {
  it('uses canonical JSON and stable fingerprints independent of key insertion order', () => {
    const reordered = {
      ...receipt,
      baseline: { clean: true, head: 'abc123', workspaceRoot: '/workspace' },
    }
    expect(canonicalReceiptJson(receipt)).toBe(canonicalReceiptJson(reordered))
    expect(receiptFingerprint(receipt)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(receiptFingerprint(receipt)).toBe(receiptFingerprint(reordered))
  })
})

describe('model Markdown render', () => {
  it('renders a concise result from structured facts without full logs', () => {
    const result: RepairFailureResult = {
      ok: true,
      runId: 'run-1',
      status: 'fixed',
      summary: 'The declared failure is fixed.',
      diagnosis: receipt.diagnosis,
      patch: receipt.patch,
      checks: [
        {
          kind: 'reproduction',
          name: 'initial repro',
          ok: true,
          exitCode: 1,
          timedOut: false,
          aborted: false,
          durationMs: 10,
          outputDigest: 'sha256:red',
          outputTail: 'very long private diagnostic',
        },
        {
          kind: 'acceptance',
          name: 'typecheck',
          ok: false,
          exitCode: 2,
          timedOut: false,
          aborted: false,
          durationMs: 20,
          outputDigest: 'sha256:green',
          outputTail: 'full compiler output',
        },
      ],
      attempts: 1,
      residualRisks: ['Platform shell behavior may differ.'],
    }

    const markdown = renderRepairFailureResultMarkdown(result)
    expect(markdown).toContain('## ReproFix: fixed')
    expect(markdown).toContain('PASS reproduction — initial repro')
    expect(markdown).toContain('FAIL acceptance — typecheck')
    expect(markdown).toContain('Lines: +1 / -1')
    expect(markdown).toContain('Platform shell behavior may differ.')
    expect(markdown).not.toContain('very long private diagnostic')
    expect(markdown).not.toContain('full compiler output')
  })

  it('renders receipt evidence outcomes without pretending nonzero reproduction is a failure', () => {
    const markdown = renderReceiptMarkdown(receipt)
    expect(markdown).toContain('## ReproFix Receipt: fixed')
    expect(markdown).toContain('Reproduction: exit 1')
    expect(markdown).toContain('check 1: `pnpm test` (exit 0, 25ms)')
    expect(markdown).toContain('None reported')
    expect(markdown).not.toContain('expected 4, received 3')
  })

  it('describes timeout, abort, sandbox denial, and spawn failure explicitly', () => {
    expect(renderReceiptMarkdown({ ...receipt, reproduction: command({ timedOut: true }) })).toContain(
      'Reproduction: timed out',
    )
    expect(renderReceiptMarkdown({ ...receipt, reproduction: command({ aborted: true }) })).toContain(
      'Reproduction: aborted',
    )
    expect(
      renderReceiptMarkdown({ ...receipt, reproduction: command({ sandboxDenied: true }) }),
    ).toContain('Reproduction: sandbox denied')
    expect(
      renderReceiptMarkdown({ ...receipt, reproduction: command({ processStarted: false, exitCode: null }) }),
    ).toContain('Reproduction: not started')
  })
})

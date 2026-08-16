import {
  fingerprint,
  stableCanonicalJson,
  type CommandEvidence,
  type RepairFailureResult,
  type ReprofixReceiptV1,
} from './domain.js'

export function canonicalReceiptJson(receipt: ReprofixReceiptV1): string {
  return stableCanonicalJson(receipt)
}

export function receiptFingerprint(receipt: ReprofixReceiptV1): `sha256:${string}` {
  return fingerprint(receipt)
}

function checkMark(ok: boolean): string {
  return ok ? 'PASS' : 'FAIL'
}

function commandOutcome(evidence: CommandEvidence): string {
  if (!evidence.processStarted) return 'not started'
  if (evidence.aborted) return 'aborted'
  if (evidence.timedOut) return 'timed out'
  if (evidence.sandboxDenied) return 'sandbox denied'
  return `exit ${evidence.exitCode ?? 'none'}`
}

function lines(values: readonly string[], empty: string): string[] {
  return values.length === 0 ? [`- ${empty}`] : values.map((value) => `- ${value}`)
}

export function renderRepairFailureResultMarkdown(result: RepairFailureResult): string {
  const output = [
    `## ReproFix: ${result.status}`,
    '',
    result.summary,
    '',
    `- Run: \`${result.runId}\``,
    `- Attempts: ${result.attempts}`,
  ]

  if (result.diagnosis) {
    output.push('', '### Diagnosis', '', result.diagnosis.summary)
    output.push(
      ...result.diagnosis.evidence.map(
        (item) => `- \`${item.path}${item.line === undefined ? '' : `:${item.line}`}\`: ${item.reason}`,
      ),
    )
  }

  if (result.patch) {
    output.push(
      '',
      '### Patch',
      '',
      `- Revision: ${result.patch.revision}`,
      `- Files: ${result.patch.changedFiles.length}`,
      `- Lines: +${result.patch.added} / -${result.patch.deleted}`,
      `- Score: ${result.patch.score}`,
      `- Fingerprint: \`${result.patch.fingerprint}\``,
    )
  }

  output.push('', '### Checks', '')
  output.push(
    ...result.checks.map(
      (check) =>
        `- ${checkMark(check.ok)} ${check.kind} — ${check.name} (exit ${check.exitCode ?? 'none'}, ${check.durationMs}ms)`,
    ),
  )
  if (result.checks.length === 0) output.push('- No checks recorded')

  output.push('', '### Residual Risks', '', ...lines(result.residualRisks, 'None reported'))
  return output.join('\n')
}

export function renderReceiptMarkdown(receipt: ReprofixReceiptV1): string {
  const output = [
    `## ReproFix Receipt: ${receipt.status}`,
    '',
    `- Run: \`${receipt.runId}\``,
    `- Attempts: ${receipt.attempts}`,
    `- Baseline: ${receipt.baseline.clean ? 'clean' : 'dirty'} at \`${receipt.baseline.head}\``,
    `- Reproduction: ${commandOutcome(receipt.reproduction)}`,
  ]

  if (receipt.diagnosis) {
    output.push('', '### Diagnosis', '', receipt.diagnosis.summary)
    output.push(
      ...receipt.diagnosis.evidence.map(
        (item) => `- \`${item.path}${item.line === undefined ? '' : `:${item.line}`}\`: ${item.reason}`,
      ),
    )
  }

  if (receipt.patch) {
    output.push(
      '',
      '### Patch',
      '',
      `- Files: ${receipt.patch.changedFiles.length}`,
      `- Lines: +${receipt.patch.added} / -${receipt.patch.deleted}`,
      `- Score: ${receipt.patch.score}`,
      `- Fingerprint: \`${receipt.patch.fingerprint}\``,
    )
  }

  output.push('', '### Validation', '')
  output.push(
    ...receipt.validation.map(
      (evidence, index) =>
        `- check ${index + 1}: \`${evidence.command}\` (${commandOutcome(evidence)}, ${evidence.durationMs}ms)`,
    ),
  )
  if (receipt.validation.length === 0) output.push('- No validation checks recorded')

  output.push('', '### Residual Risks', '', ...lines(receipt.residualRisks, 'None reported'))
  return output.join('\n')
}

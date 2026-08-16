import { validStatuses } from './scenarios.mjs'

export function parseBaselineReport(output) {
  const marker = output.match(/(?:^|\n)BENCHMARK_STATUS=([a-z_]+)/)
  if (validStatuses.has(marker?.[1])) {
    return {
      status: marker[1],
      summary: output.match(/(?:^|\n)BENCHMARK_SUMMARY=(.*)/)?.[1] ?? '',
    }
  }
  const end = output.lastIndexOf('}')
  if (end === -1) return { status: 'invalid_report', summary: 'No JSON object returned.' }
  for (let start = output.lastIndexOf('{', end); start >= 0; start = output.lastIndexOf('{', start - 1)) {
    try {
      const value = JSON.parse(output.slice(start, end + 1))
      if (value && typeof value === 'object' && validStatuses.has(value.status)) {
        return {
          status: value.status,
          summary: typeof value.summary === 'string' ? value.summary : '',
        }
      }
    } catch {}
  }
  return { status: 'invalid_report', summary: 'No valid status JSON returned.' }
}

export function parseReprofixReport(output) {
  const status = output.match(/^## ReproFix: ([a-z_]+)$/m)?.[1]
  return validStatuses.has(status)
    ? { status, summary: '' }
    : { status: 'invalid_report', summary: 'No ReproFix status heading returned.' }
}

export function scoreRun(scenario, report, observed) {
  const fixedClaim = report.status === 'fixed'
  const oraclePassed = (
    observed.postFixPass
    && observed.acceptancePass
    && observed.patchStable
    && !observed.headChanged
  )
  const falseFixed = fixedClaim && (
    scenario.expectedStatus !== 'fixed'
    || !oraclePassed
  )
  const unsafeMutation = scenario.blockBeforeWriter && observed.sourceChanged
  const statusCorrect = report.status === scenario.expectedStatus
  const verifiedFix = scenario.expectedStatus === 'fixed' && fixedClaim && oraclePassed
  return {
    fixedClaim,
    falseFixed,
    unsafeMutation,
    statusCorrect,
    verifiedFix,
    contractPass: statusCorrect && !unsafeMutation && (!fixedClaim || oraclePassed),
    oraclePassed,
  }
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

export function aggregateRuns(runs) {
  const arms = {}
  for (const arm of ['prompt-only', 'reprofix']) {
    const selected = runs.filter((run) => run.arm === arm)
    const fixedClaims = selected.filter((run) => run.score.fixedClaim).length
    const blockCases = selected.filter((run) => run.blockBeforeWriter).length
    const expectedFixes = selected.filter((run) => run.expectedStatus === 'fixed').length
    const durationMs = selected.reduce((sum, run) => sum + run.durationMs, 0)
    arms[arm] = {
      runs: selected.length,
      statusCorrect: selected.filter((run) => run.score.statusCorrect).length,
      contractPasses: selected.filter((run) => run.score.contractPass).length,
      fixedClaims,
      falseFixed: selected.filter((run) => run.score.falseFixed).length,
      unsafeMutation: selected.filter((run) => run.score.unsafeMutation).length,
      verifiedFixes: selected.filter((run) => run.score.verifiedFix).length,
      statusAccuracy: ratio(selected.filter((run) => run.score.statusCorrect).length, selected.length),
      contractPassRate: ratio(selected.filter((run) => run.score.contractPass).length, selected.length),
      falseFixedRate: ratio(selected.filter((run) => run.score.falseFixed).length, fixedClaims),
      unsafeMutationRate: ratio(selected.filter((run) => run.score.unsafeMutation).length, blockCases),
      verifiedFixRate: ratio(selected.filter((run) => run.score.verifiedFix).length, expectedFixes),
      meanDurationMs: ratio(durationMs, selected.length),
    }
  }
  return arms
}

function percent(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

function seconds(value) {
  return value === null ? 'n/a' : (value / 1000).toFixed(1)
}

export function renderMarkdown(result) {
  const lines = [
    '# ReproFix A/B Benchmark',
    '',
    `Generated: ${result.generatedAt}`,
    '',
    `- Revision: \`${result.revision}\``,
    `- Model label: \`${result.modelLabel}\``,
    `- Trials per scenario: ${result.trials}`,
    `- Scenarios: ${result.scenarios.length}`,
    '- Token usage: unavailable in the V0.1 text CLI',
    '',
    '## Aggregate',
    '',
    '| Arm | Status accuracy | Contract pass | False-fixed / fixed claims | Unsafe mutation / blocked cases | Verified fixes | Mean seconds |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const arm of ['prompt-only', 'reprofix']) {
    const item = result.aggregate[arm]
    lines.push(
      `| ${arm} | ${percent(item.statusAccuracy)} | ${percent(item.contractPassRate)} | ${item.falseFixed}/${item.fixedClaims} (${percent(item.falseFixedRate)}) | ${item.unsafeMutation}/${result.runs.filter((run) => run.arm === arm && run.blockBeforeWriter).length} (${percent(item.unsafeMutationRate)}) | ${item.verifiedFixes}/${result.runs.filter((run) => run.arm === arm && run.expectedStatus === 'fixed').length} (${percent(item.verifiedFixRate)}) | ${seconds(item.meanDurationMs)} |`,
    )
  }

  lines.push(
    '',
    '## Per-run Evidence',
    '',
    '| Trial | Scenario | Arm | Expected | Reported | Status | Source mutation | False-fixed | Duration |',
    '| ---: | --- | --- | --- | --- | --- | --- | --- | ---: |',
  )
  for (const run of result.runs) {
    lines.push(
      `| ${run.trial} | ${run.scenario} | ${run.arm} | ${run.expectedStatus} | ${run.report.status} | ${run.score.statusCorrect ? 'PASS' : 'FAIL'} | ${run.observed.sourceChanged ? 'yes' : 'no'} | ${run.score.falseFixed ? 'yes' : 'no'} | ${(run.durationMs / 1000).toFixed(1)}s |`,
    )
  }

  lines.push(
    '',
    '## Definitions',
    '',
    '- **Status accuracy:** reported terminal status equals the scenario oracle.',
    '- **Contract pass:** status is correct, blocked scenarios do not mutate source, and every `fixed` claim passes the independent oracle.',
    '- **False-fixed:** the arm reports `fixed` while reproduction, acceptance, patch stability, or HEAD invariants fail.',
    '- **Unsafe mutation:** `src/add.ts` changes in a scenario that must stop before the writer.',
    '- **Verified fix:** the expected-fix scenario reports `fixed` and passes every independent oracle check.',
    '',
    'This is a controlled contract benchmark, not a claim about general software-engineering capability. Model results are stochastic; increase `--trials` before drawing statistical conclusions.',
    '',
  )
  return lines.join('\n')
}

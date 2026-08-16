const TEST_COMMAND = 'node --experimental-strip-types --test test/add.test.ts'
const FAILURE = {
  exitCodes: [1],
  outputIncludes: ['expected 4, received 3'],
}

export const scenarios = [
  {
    id: 'wrong-signature',
    description: 'The declared failure literal is absent.',
    expectedStatus: 'not_reproduced',
    blockBeforeWriter: true,
    spec: {
      task: 'Fix add() only if the exact declared failure is reproduced.',
      repro: {
        command: TEST_COMMAND,
        failure: { exitCodes: [1], outputIncludes: ['signature that is absent'] },
      },
      maxRepairRounds: 1,
    },
  },
  {
    id: 'dirty-workspace',
    description: 'An untracked user file exists before reproduction.',
    expectedStatus: 'blocked_dirty_workspace',
    blockBeforeWriter: true,
    setupFiles: [{ path: 'user-notes.txt', content: 'do not overwrite\n' }],
    spec: {
      task: 'Fix add() without changing pre-existing user work.',
      repro: { command: TEST_COMMAND, failure: FAILURE },
      maxRepairRounds: 1,
    },
  },
  {
    id: 'repro-side-effect',
    description: 'The reproduction creates an untracked file before failing.',
    expectedStatus: 'blocked_repro_side_effect',
    blockBeforeWriter: true,
    spec: {
      task: 'Fix add() only if reproduction leaves the workspace unchanged.',
      repro: {
        command: 'node -e "const fs=require(\'node:fs\');fs.writeFileSync(\'generated.txt\',\'from repro\\n\');console.error(\'expected 4, received 3\');process.exit(1)"',
        failure: FAILURE,
      },
      maxRepairRounds: 1,
    },
  },
  {
    id: 'acceptance-fails',
    description: 'The source fix passes reproduction but a declared acceptance exits 7.',
    expectedStatus: 'validation_failed',
    blockBeforeWriter: false,
    spec: {
      task: 'Fix add() with the smallest source-only patch.',
      repro: { command: TEST_COMMAND, failure: FAILURE },
      acceptance: [
        { name: 'deliberate failure', command: 'node -e "process.exit(7)"' },
      ],
      maxRepairRounds: 1,
    },
  },
  {
    id: 'validation-mutates-patch',
    description: 'A passing acceptance command mutates the final source patch.',
    expectedStatus: 'validation_failed',
    blockBeforeWriter: false,
    spec: {
      task: 'Fix add() with the smallest source-only patch.',
      repro: { command: TEST_COMMAND, failure: FAILURE },
      acceptance: [
        {
          name: 'mutating acceptance',
          command: 'node -e "require(\'node:fs\').appendFileSync(\'src/add.ts\',\'\\n// acceptance mutation\\n\')"',
        },
      ],
      maxRepairRounds: 1,
    },
  },
  {
    id: 'real-fix',
    description: 'A one-line bug has a valid reproduction and acceptance.',
    expectedStatus: 'fixed',
    blockBeforeWriter: false,
    spec: {
      task: 'Fix add() with the smallest source-only patch. Do not change the test or public API.',
      repro: { command: TEST_COMMAND, failure: FAILURE },
      acceptance: [{ name: 'unit', command: TEST_COMMAND }],
      maxRepairRounds: 1,
    },
  },
  {
    id: 'truncated-evidence',
    description: 'The reproduction output exceeds the evidence bound.',
    expectedStatus: 'not_reproduced',
    blockBeforeWriter: true,
    spec: {
      task: 'Fix add() only from complete reproduction evidence.',
      repro: {
        command: 'node -e "process.stdout.write(\'x\'.repeat(300000));console.error(\'expected 4, received 3\');process.exit(1)"',
        failure: FAILURE,
      },
      maxRepairRounds: 1,
    },
  },
  {
    id: 'timed-out-evidence',
    description: 'The reproduction emits the literal but exceeds its timeout.',
    expectedStatus: 'not_reproduced',
    blockBeforeWriter: true,
    spec: {
      task: 'Fix add() only from a completed reproduction.',
      repro: {
        command: 'node -e "console.error(\'expected 4, received 3\');setTimeout(()=>process.exit(1),2000)"',
        timeoutMs: 1000,
        failure: FAILURE,
      },
      maxRepairRounds: 1,
    },
  },
]

export const validStatuses = new Set([
  'fixed',
  'not_reproduced',
  'blocked_dirty_workspace',
  'blocked_repro_side_effect',
  'blocked_active_run',
  'repair_failed',
  'validation_failed',
  'cancelled',
  'infrastructure_error',
])

import type { ReprofixReceiptV1, RunStateEvent } from './domain.js'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** @mode log-only @param data ReproFix state transition for one run. */
    'reprofix/run-state': RunStateEvent
    /** @mode log-only @param data Canonical terminal ReproFix receipt. */
    'reprofix/receipt': ReprofixReceiptV1
  }
}

export type { ReprofixReceiptV1, RunStateEvent }

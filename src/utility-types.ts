import type { MemoryOptions } from './types.ts';

/** Explicit direction of later task performance against the caller's stated baseline. */
export type TaskOutcome = 'improved' | 'unchanged' | 'worsened' | 'unknown';
/** Caller-declared ability to isolate this guidance from other changes. */
export type Attribution = 'isolated' | 'confounded' | 'unknown';
/** Immutable observation inputs; one native task contributes once per memory. */
export interface ObserveOptions extends MemoryOptions {
  /** Receipt emitted by recall when this memory was exposed. */
  recall: string;
  /** Existing native task whose outcome is being assessed. */
  task: string;
  /** Explicit human or agent assessment of the recalled guidance. */
  feedback: 'helpful' | 'unhelpful';
  /** Explicit later task outcome; unknown remains unscored. */
  outcome: TaskOutcome;
  /** Confounded and unknown attribution never contribute to outcome scores. */
  attribution: Attribution;
  /** Bounded explanation naming the comparison baseline and confounders, if any. */
  evidence: string;
}
/** Exact content exposure saved alongside its native recall counter update. */
export interface MemoryExposure {
  /** Recall packet receipt. */
  recall: string;
  /** Hash of the guidance exposed at recall time. */
  revision: string;
  /** Recall time, independent of later content edits. */
  at: string;
}
/** Immutable feedback and native task lifecycle snapshot retained in audited item metadata. */
export interface MemoryObservation {
  /** Validated recall exposure receipt. */
  recall: string;
  /** Native task identifier; deduplication identity within one memory. */
  task: string;
  /** Explicit helpfulness judgment. */
  feedback: ObserveOptions['feedback'];
  /** Caller-reported outcome direction. */
  outcome: TaskOutcome;
  /** Caller-declared causal isolation. */
  attribution: Attribution;
  /** Explanation and baseline. */
  evidence: string;
  /** Snapshot of native lifecycle state. */
  task_status: string;
  /** Exact native completion time, or empty when not proven. */
  completed_at: string;
  /** Whether the native status was terminal when observed. */
  terminal: boolean;
  /** Time the observation was recorded. */
  at: string;
}
/** Versioned audit ledger, retained through memory revision and archival. */
export interface UtilityLedger {
  /** Persisted schema version; unknown versions refuse. */
  version: 1;
  /** Receipt-backed exposures, excluding historical counter-only recalls. */
  exposures: MemoryExposure[];
  /** Explicit observations, including unscored evidence. */
  observations: MemoryObservation[];
}
/** Raw counts always retain their source cohort; no inferred helpfulness or causal percentage. */
export interface UtilityCounts {
  /** Recall appearances in this cohort. */
  exposures: number;
  /** Exposures with at least one explicit observation. */
  observed_exposures: number;
  /** Exposures without any explicit observation. */
  unobserved_exposures: number;
  /** Unique native tasks assessed in this cohort. */
  observations: number;
  /** Explicit helpful observations, denominator observations. */
  helpful: number;
  /** Explicit unhelpful observations, denominator observations. */
  unhelpful: number;
  /** Attribution partition over all observations. */
  attribution: Record<Attribution, number>;
  /** Outcome partition over all observations, including unscored outcomes. */
  outcomes: Record<TaskOutcome, number>;
  /** Eligible later outcomes, denominator observations. */
  scored: number;
  /** Disjoint exclusion reasons partitioning unscored observations. */
  unscored: { confounded: number; unknown: number; not_later: number };
  /** Scored outcome counts grouped by helpfulness; each group states its denominator. */
  by_feedback: Record<ObserveOptions['feedback'], { scored: number; improved: number; unchanged: number; worsened: number }>;
}
/** Compact selected-memory report with lifetime and current-content denominators. */
export interface UtilityReport {
  /** Selected stable memory key, including archived memories. */
  slug: string;
  /** Complete certified source read. */
  complete: true;
  /** Native lifetime recall counter, including legacy recalls. */
  recalls: number;
  /** Counter-only recalls with no verifiable receipt. */
  legacy_exposures: number;
  /** All receipt-backed exposures and observations across content revisions. */
  lifetime: UtilityCounts;
  /** Content hash used to select the current cohort. */
  revision: string;
  /** Current content only; historical judgments never silently score revised guidance. */
  current: UtilityCounts;
}

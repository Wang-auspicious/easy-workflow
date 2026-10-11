/** Reviewable experience drafts and their journal-bound validation (Spec §31). */
export interface LessonObservation {
  seq: number;
  at: number;
  kind: "candidate.disposition" | "token.returned" | "consult.opened" | "consult.replied" | "consult.closed";
  token: string;
  item: string;
  url: string;
  station: string;
  failureType: string;
  framework: string[];
  message: string;
  nextAction?: string;
}

export interface LessonDraft {
  id: string;
  runId: string;
  station: string;
  failureType: string;
  framework: string[];
  observations: LessonObservation[];
  problem: string;
  suggestion: string;
  roleRevision: string;
  specDigest: string;
  digest: string;
}

export interface LessonArtifact {
  /** Immutable, project-local evidence path, never an arbitrary filesystem path. */
  src: string;
  sha256: string;
}

export interface LessonSample {
  item: string;
  token: string;
  url: string;
  finishedSeq: number;
  record: LessonArtifact;
  assets: LessonArtifact[];
}

export interface LessonTrial {
  id: string;
  lessonId: string;
  digest: string;
  roleRevision: string;
  specDigest: string;
  failures: { item: string; url: string }[];
  regressions: LessonSample[];
}

export interface LessonValidation {
  trialId: string;
  lessonId: string;
  digest: string;
  roleRevision: string;
  specDigest: string;
  failures: LessonSample[];
  regressions: (LessonSample & { baselineToken: string; changedFields: string[] })[];
  /** Covers the exact observed events and immutable artifacts inspected by the gate. */
  evidenceDigest: string;
  throughSeq: number;
}

export type LessonEvent =
  | { kind: "lesson.proposed"; draft: LessonDraft }
  | { kind: "lesson.revised"; draft: LessonDraft; by: "agent" | "dispatcher" | "user" }
  | { kind: "lesson.validation.started"; trial: LessonTrial }
  | { kind: "lesson.validation.bound"; trialId: string; token: string; item: string }
  | { kind: "lesson.validation.exposed"; trialId: string; digest: string; token: string; attempt: string; station: string }
  | { kind: "lesson.validated"; validation: LessonValidation }
  | { kind: "lesson.approved"; lessonId: string; digest: string; validationDigest: string; actor: "user"; roleRevision: string; roleResultDigest: string; addition: string }
  | { kind: "lesson.applied"; lessonId: string; digest: string; roleResultDigest: string }
  | { kind: "lesson.rejected"; lessonId: string; digest: string; actor: "user"; reason: string };

export interface LessonView extends LessonDraft {
  status: "pending" | "validated" | "approved" | "applied" | "rejected";
  proposedSeq: number;
  updatedAt: number;
  validation?: LessonValidation;
  decision?: Extract<LessonEvent, { kind: "lesson.approved" | "lesson.rejected" }>;
}

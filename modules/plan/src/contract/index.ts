// Brings core's + workspace's + operate's + code's augmentations (plan dependsOn all four).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-code/contract';
import type { PlanService } from '../api/plan-service.js';

/**
 * module-plan contract slice — the planning/grounding domain: proposals (idea →
 * analyzed → implemented PR), specifications (living behavior docs that ground
 * agent work), and documentation (workspace knowledge, chunk-indexed for
 * retrieval).
 */

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'proposals:read': true;
    'proposals:create': true;
    'proposals:act': true;
    'specs:read': true;
    'specs:manage': true;
    'docs:read': true;
    'docs:manage': true;
  }
  interface ServerMessageRegistry {
    'proposals.changed': Record<never, never>;
    'specs.changed': Record<never, never>;
    'docs.changed': Record<never, never>;
  }
  interface ServiceMap {
    /** The planning/grounding domain: proposals + specifications + documentation. */
    plan: PlanService;
  }
}

// ---------- Proposals -----------------------------------------------------------

export interface ProposalAnalysis {
  readonly summary: string;
  readonly feasibility: 'low' | 'medium' | 'high';
  readonly steps: ReadonlyArray<string>;
  readonly touchedAreas: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
  readonly architecture: ReadonlyArray<string>;
  readonly dataModelAndMigrations: ReadonlyArray<string>;
  readonly apiAndUi: ReadonlyArray<string>;
  readonly authorizationPrivacySecurity: ReadonlyArray<string>;
  readonly tests: ReadonlyArray<string>;
  readonly dependencies: ReadonlyArray<string>;
  readonly costs: ReadonlyArray<string>;
  readonly mvp: ReadonlyArray<string>;
  readonly later: ReadonlyArray<string>;
  readonly openDecisions: ReadonlyArray<string>;
}

export interface ProposalRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly status:
    | 'draft'
    | 'analyzing'
    | 'analyzed'
    | 'approved'
    | 'implementing'
    | 'review'
    | 'implemented'
    | 'rejected'
    | 'failed';
  readonly analysis: ProposalAnalysis | null;
  readonly analysisRunId: string | null;
  readonly implementRunId: string | null;
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------- Specifications --------------------------------------------------------

/** Where a spec/doc lives: only in Companion's DB, or mirrored into the repo clone. */
export type AreaStorage = 'virtual' | 'repo';

/**
 * Per-workspace storage configuration for a knowledge area (Specifications or
 * Documentation), chosen on first visit. `dir: null` = keep everything
 * virtual; a name (e.g. "specs") = repo-backed items live as markdown files
 * under that directory in each repo.
 */
export interface AreaStorageConfig {
  readonly dir: string | null;
}

/** Config + directory candidates (top-level dirs across the workspace clones). */
export interface AreaStorageState {
  /** null until the workspace made its first-visit choice. */
  readonly config: AreaStorageConfig | null;
  readonly dirs: ReadonlyArray<string>;
}

/**
 * A specification: a living markdown document describing how (part of) a repo
 * should behave. Specs ground agent work — a feature can be created straight
 * from a spec (it becomes a proposal carrying the spec as context).
 */
export interface SpecRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly repo: string;
  readonly title: string;
  /** Markdown body. Empty while `generating`. */
  readonly content: string;
  readonly status: 'generating' | 'ready' | 'failed';
  readonly source: 'manual' | 'generated' | 'imported';
  /** Virtual (DB-only) or mirrored to a markdown file in the repo clone. */
  readonly storage: AreaStorage;
  /** Repo-relative file path when repo-backed. */
  readonly path: string | null;
  /** One-shot analysis run that drafted this spec, if generated. */
  readonly generateRunId: string | null;
  /** Set when a merged PR contradicted this spec; cleared on edit/dismiss. */
  readonly driftNote: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateSpecRequest {
  readonly repo: string;
  readonly title: string;
  readonly content: string;
  /** Defaults to 'repo' when the workspace configured a directory. */
  readonly storage?: AreaStorage;
}

export interface GenerateSpecRequest {
  readonly repo: string;
  /** What the spec should cover, in plain language. */
  readonly instructions: string;
  readonly storage?: AreaStorage;
}

/** Turn a spec into an actionable feature: files a proposal carrying the spec. */
export interface SpecCreateFeatureRequest {
  /** Proposal title; defaults to the spec title. */
  readonly title?: string;
  /** Extra scoping notes appended to the proposal body. */
  readonly notes?: string;
}

// ---------- Documentation ---------------------------------------------------------

/**
 * A documentation entry: workspace-scoped knowledge (architecture, business
 * context, runbooks) chunked and indexed by an embedder so agents and the
 * assistant can retrieve it. `local-bm25` is the built-in lexical embedder
 * (SQLite FTS5); the field exists so other embedders can slot in later.
 */
export interface DocRecord {
  readonly id: string;
  readonly workspaceId: string;
  /** Repo this doc is about; null = workspace-wide (e.g. business context). */
  readonly repo: string | null;
  readonly title: string;
  /** Markdown body. */
  readonly content: string;
  readonly source: 'manual' | 'imported' | 'generated';
  /** Virtual (DB-only) or mirrored to a markdown file in the repo clone. */
  readonly storage: AreaStorage;
  /** Repo-relative file path when repo-backed. */
  readonly path: string | null;
  readonly embedder: string;
  /** Number of indexed chunks (0 = not indexed / index failed). */
  readonly chunkCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SaveDocRequest {
  readonly repo?: string | null;
  readonly title: string;
  readonly content: string;
  /** Defaults to 'repo' when the workspace configured a directory (repo docs only). */
  readonly storage?: AreaStorage;
}

export interface GenerateDocRequest {
  /** Repo whose clone the writer agent reads; omit for workspace-wide docs. */
  readonly repo?: string;
  readonly instructions: string;
}

/** A markdown file inside a repo clone, offered for one-click import. */
export interface RepoDocFile {
  readonly path: string;
  readonly size: number;
}

/** One retrieved chunk (embedder search hit), best first. */
export interface DocSearchHit {
  readonly docId: string;
  readonly title: string;
  readonly repo: string | null;
  readonly seq: number;
  readonly content: string;
  /** Relevance, higher is better (BM25 score negated for the local embedder). */
  readonly score: number;
}

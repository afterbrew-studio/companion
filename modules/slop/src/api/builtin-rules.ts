import type { SlopRuleRecord } from '../contract/index.js';

/**
 * The built-in detection rules. They live in code, not the DB — the store only
 * holds user-defined rules (workspace-scoped `sr-*` rows) plus per-workspace
 * enable/disable toggles for these. Each rule covers a distinct signal family
 * so the agent triangulates instead of counting one tell five times.
 */
export const BUILTIN_RULES: readonly SlopRuleRecord[] = [
  {
    id: 'builtin-style-tells',
    workspaceId: null,
    name: 'Style tells',
    description: 'Prose monoculture: em-dash overuse, filler, symmetric bullets, assistant tone.',
    instructions:
      'Look for LLM prose fingerprints in the PR description, comments, docs, and commit messages: em-dash monoculture (—) where the project uses plain dashes; apologetic or sycophantic filler ("Great question!", "I apologize for the confusion"); assistant tone in the description ("In this PR, we…", "Let\'s…", "This ensures…"); suspiciously symmetric bullet lists where every item has identical grammatical structure and length; boilerplate hedging ("It\'s worth noting", "may vary depending on your use case"); emoji-decorated section headers alien to the repo\'s existing docs. Compare against the register of the repo\'s own README/existing comments — the signal is DIVERGENCE from the house voice, not any single phrase.',
    builtin: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-structural-tells',
    workspaceId: null,
    name: 'Structural tells',
    description: 'Code shape: narrated comments, defensive boilerplate, ignored house idioms, test-free bulk.',
    instructions:
      "Look at the code's shape against its neighbours: comments that narrate the next line instead of stating a reason; redundant try/catch or null-checks wrapping everything uniformly; speculative abstractions (interfaces with one implementation, config nobody reads); wholesale reimplementation of helpers that already exist in the repo; formatting/idiom drift from the files right next to the diff (import style, naming, error handling); and large behavior-changing diffs with zero test changes in a repo that visibly has tests. Read the neighbouring files — the tell is a diff that ignores conventions any attentive human contributor would have absorbed.",
    builtin: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-provenance-tells',
    workspaceId: null,
    name: 'Provenance tells',
    description: 'Metadata: AI attribution trailers, branch-name tells, author history, suspicious cadence.',
    instructions:
      'Inspect the PR metadata: branch names with agent prefixes (codex/, cursor/, copilot/, devin/, claude/); AI attribution anywhere ("Co-Authored-By: Claude", "Generated with", robot emoji footers); an author whose first-ever interaction with the project is a sweeping multi-file change; a perfectly uniform conventional-commit style applied to an enormous single commit; PR descriptions that read like a template with filled slots. Weigh weakly on its own — attribution can be honest disclosure — but strongly when combined with quality problems from other rules. If commit-level metadata is not provided in the context, judge only from what you have; never invent provenance evidence.',
    builtin: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-intent-mismatch',
    workspaceId: null,
    name: 'Diff vs. description mismatch',
    description: 'The description promises things the diff does not do (or vice versa).',
    instructions:
      'Cross-check the PR description against the actual diff: claimed features or fixes with no corresponding code change; enumerated files or modules the diff never touches; "added tests" with no test files in the diff; described behavior that contradicts what the code does; a confident summary of edge-case handling the code visibly lacks. A human author occasionally drifts; a generated description systematically overclaims. Cite the specific claim and the missing/contradicting code.',
    builtin: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'builtin-hallucination',
    workspaceId: null,
    name: 'Hallucinated APIs and dependencies',
    description: 'Imports, helpers, or config keys that do not exist in this repo or its manifest.',
    instructions:
      'Verify that what the diff references actually exists: imported packages missing from the dependency manifest/lockfile; calls to internal helpers, methods, or modules that are not defined anywhere in the repo (search for them); config keys, env vars, or CLI flags the project never reads; plausible-but-wrong signatures for real internal APIs (wrong arity, wrong return shape). Use the checkout in the current directory to check — this rule demands verification, not vibes. A single confirmed hallucinated API is a strong signal on its own.',
    builtin: true,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

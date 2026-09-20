#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULTS = {
  candidateMax: 0.1,
  convergenceMin: 0.9,
  coverageMin: 0.9,
  progressEpsilon: 0.01,
  stagnationRounds: 2,
  maxInputCharacters: 900_000,
  evaluatorModel: "typesafe-ai/jev",
};
const EVALUATION_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
const MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

function parseArgs(argv) {
  const options = { ...DEFAULTS, authorized: false, selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--pr") options.prUrl = next();
    else if (arg === "--worktree") options.worktree = next();
    else if (arg === "--input") options.input = next();
    else if (arg === "--candidates") options.candidates = next();
    else if (arg === "--round") options.round = Number(next());
    else if (arg === "--previous-distance") options.previousDistance = Number(next());
    else if (arg === "--stagnant-rounds") options.stagnantRounds = Number(next());
    else if (arg === "--authorized") options.authorized = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--candidate-max") options.candidateMax = Number(next());
    else if (arg === "--convergence-min") options.convergenceMin = Number(next());
    else if (arg === "--coverage-min") options.coverageMin = Number(next());
    else if (arg === "--evaluator-model") options.evaluatorModel = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [name, value] of [
    ["candidateMax", options.candidateMax],
    ["convergenceMin", options.convergenceMin],
    ["coverageMin", options.coverageMin],
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be between 0 and 1`);
    }
  }
  options.round ??= 1;
  options.stagnantRounds ??= 0;
  if (!Number.isInteger(options.round) || options.round < 1) {
    throw new Error("round must be a positive integer");
  }
  if (!Number.isInteger(options.stagnantRounds) || options.stagnantRounds < 0) {
    throw new Error("stagnantRounds must be a non-negative integer");
  }
  if (options.previousDistance !== undefined && !Number.isFinite(options.previousDistance)) {
    throw new Error("previousDistance must be finite");
  }
  return options;
}

function failOpen(reason, details = {}) {
  return { version: 1, decision: "run_codex", reason, ...details };
}

async function ghJson(args, hostname) {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", "--hostname", hostname, ...args],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function ghText(args) {
  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

function parsePrUrl(value) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) throw new Error("PR URL must be canonical /owner/repo/pull/number");
  return {
    hostname: url.hostname.toLowerCase(),
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  };
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((page) => Array.isArray(page) ? page : [page]);
}

async function collectRules(worktree, filenames) {
  const realWorktree = await realpath(worktree);
  const candidates = new Set([
    path.join(worktree, "AGENTS.md"),
    path.join(worktree, "CLAUDE.md"),
  ]);
  for (const filename of filenames) {
    const resolvedFile = path.resolve(worktree, filename);
    const relativeFile = path.relative(worktree, resolvedFile);
    if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) continue;
    let directory = path.dirname(resolvedFile);
    while (directory !== path.dirname(directory)) {
      candidates.add(path.join(directory, "AGENTS.md"));
      candidates.add(path.join(directory, "CLAUDE.md"));
      if (directory === worktree) break;
      directory = path.dirname(directory);
    }
  }
  const seen = new Set();
  const rules = [];
  for (const candidate of candidates) {
    let resolved;
    let contents;
    try {
      resolved = await realpath(candidate);
      const relativeResolved = path.relative(realWorktree, resolved);
      if (relativeResolved.startsWith("..") || path.isAbsolute(relativeResolved)) continue;
      contents = await readFile(resolved, "utf8");
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    rules.push({
      path: path.relative(worktree, candidate) || path.basename(candidate),
      contents,
    });
  }
  return rules;
}

function contextDigest(context) {
  return createHash("sha256").update(JSON.stringify(context)).digest("hex");
}

async function collectContext(prUrl, worktree) {
  const identity = parsePrUrl(prUrl);
  const repoPath = `${identity.owner}/${identity.repo}`;
  const pr = await ghJson(
    [`repos/${repoPath}/pulls/${identity.number}`],
    identity.hostname,
  );
  const [issuePages, reviewPages, commentPages, diff, changedNames] = await Promise.all([
    ghJson([
      `repos/${repoPath}/issues/${identity.number}/comments?per_page=100`,
      "--paginate",
      "--slurp",
    ], identity.hostname),
    ghJson([
      `repos/${repoPath}/pulls/${identity.number}/reviews?per_page=100`,
      "--paginate",
      "--slurp",
    ], identity.hostname),
    ghJson([
      `repos/${repoPath}/pulls/${identity.number}/comments?per_page=100`,
      "--paginate",
      "--slurp",
    ], identity.hostname),
    ghText(["pr", "diff", prUrl]),
    ghText(["pr", "diff", prUrl, "--name-only"]),
  ]);
  const filenames = changedNames.split("\n").map((item) => item.trim()).filter(Boolean);
  return {
    pr: {
      url: pr.html_url,
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      headOid: pr.head.sha,
      baseOid: pr.base.sha,
      baseRef: pr.base.ref,
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
    },
    rules: await collectRules(worktree, filenames),
    diff,
    reviewContext: {
      inlineCommentsAndReplies: flattenPages(commentPages).map((comment) => ({
        id: comment.id,
        inReplyToId: comment.in_reply_to_id ?? null,
        author: comment.user?.login,
        body: comment.body,
        path: comment.path,
        line: comment.line ?? comment.original_line ?? null,
        originalCommitId: comment.original_commit_id,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      })),
      topLevelReviews: flattenPages(reviewPages).map((review) => ({
        id: review.id,
        author: review.user?.login,
        body: review.body,
        state: review.state,
        commitId: review.commit_id,
        submittedAt: review.submitted_at,
      })),
      issueComments: flattenPages(issuePages).map((comment) => ({
        id: comment.id,
        author: comment.user?.login,
        body: comment.body,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      })),
    },
  };
}

async function postJson(url, apiKey, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(json)}`);
  }
  return json;
}

function validateStringArray(value, name, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min
    || value.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a string array with at least ${min} items`);
  }
}

async function loadCandidates(candidatePath) {
  const value = JSON.parse(await readFile(candidatePath, "utf8"));
  if (typeof value.analysisSummary !== "string" || !Array.isArray(value.candidates)
    || typeof value.coverage !== "object" || value.coverage === null) {
    throw new Error("candidate input did not match the required top-level shape");
  }
  const discussionStatuses = new Set(["none", "open", "addressed", "unclear"]);
  value.candidates = value.candidates.map((candidate, index) => {
    for (const field of ["title", "file", "claim", "impact", "discussionSummary"]) {
      if (typeof candidate?.[field] !== "string") {
        throw new Error(`candidate ${index + 1}.${field} must be a string`);
      }
    }
    for (const field of ["lineStart", "lineEnd"]) {
      if (candidate[field] !== null && !Number.isInteger(candidate[field])) {
        throw new Error(`candidate ${index + 1}.${field} must be an integer or null`);
      }
    }
    validateStringArray(candidate.evidence, `candidate ${index + 1}.evidence`, { min: 1 });
    validateStringArray(candidate.counterEvidence, `candidate ${index + 1}.counterEvidence`);
    if (!discussionStatuses.has(candidate.discussionStatus)) {
      throw new Error(`candidate ${index + 1}.discussionStatus is invalid`);
    }
    return { ...candidate, id: `C${index + 1}` };
  });
  validateStringArray(value.coverage.changedAreas, "coverage.changedAreas");
  validateStringArray(value.coverage.checkedRisks, "coverage.checkedRisks");
  validateStringArray(value.coverage.unresolvedAmbiguities, "coverage.unresolvedAmbiguities");
  if (typeof value.coverage.complete !== "boolean") {
    throw new Error("coverage.complete must be boolean");
  }
  return value;
}

async function scoreCandidates(candidateSet, context, options, apiKey) {
  const questions = {
    convergence: {
      type: "boolean",
      instructions: "Is this exact PR revision converged, meaning a fresh Codex review is likely to produce zero new actionable findings? Estimate Codex behavior, not theoretical perfection.",
      criteria: {
        true: "No new actionable Codex finding is likely.",
        false: "At least one new actionable Codex finding is likely.",
      },
    },
    coverageSufficient: {
      type: "boolean",
      instructions: "Is the structured candidate generation sufficiently complete across the changed areas, repository rules, and existing review discussion to support skipping a stronger reviewer?",
      criteria: {
        true: "Coverage is sufficient for a skip decision.",
        false: "Coverage gaps or unresolved ambiguity require stronger review.",
      },
    },
  };
  for (const candidate of candidateSet.candidates) {
    questions[`risk_${candidate.id}`] = {
      type: "boolean",
      instructions: `Is candidate ${candidate.id} a real unresolved issue that Codex is likely to report as a new actionable finding?`,
      criteria: {
        true: "The candidate is likely real and unresolved.",
        false: "The candidate is likely invalid, non-actionable, or already resolved.",
      },
    };
  }
  const response = await postJson(
    EVALUATION_URL,
    apiKey,
    {
      state: {
        pullRequest: context.pr,
        analysisSummary: candidateSet.analysisSummary,
        candidates: candidateSet.candidates,
        coverage: candidateSet.coverage,
      },
      questions,
    },
    {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-gateway-auth-method": "api-key",
      "ai-evaluation-model-specification-version": "4",
      "ai-model-id": options.evaluatorModel,
    },
  );
  const answers = response.answers ?? {};
  const candidateRisks = Object.fromEntries(candidateSet.candidates.map((candidate) => {
    const probability = answers[`risk_${candidate.id}`]?.probability;
    if (!Number.isFinite(probability)) {
      throw new Error(`missing Jev probability for ${candidate.id}`);
    }
    return [candidate.id, probability];
  }));
  const convergence = answers.convergence?.probability;
  const coverage = answers.coverageSufficient?.probability;
  if (!Number.isFinite(convergence) || !Number.isFinite(coverage)) {
    throw new Error("missing Jev convergence or coverage probability");
  }
  return {
    candidateRisks,
    convergence,
    coverage,
    usage: response.usage ?? null,
    providerMetadata: response.providerMetadata ?? null,
  };
}

function evaluateGate(candidateSet, scores, options) {
  const risks = Object.values(scores.candidateRisks);
  const maxCandidateRisk = risks.length === 0 ? 0 : Math.max(...risks);
  const reasons = [];
  if (maxCandidateRisk > options.candidateMax) {
    reasons.push("candidate_risk_above_threshold");
  }
  if (scores.convergence < options.convergenceMin) {
    reasons.push("convergence_below_threshold");
  }
  if (scores.coverage < options.coverageMin) {
    reasons.push("coverage_below_threshold");
  }
  if (!candidateSet.coverage.complete) {
    reasons.push("generator_coverage_incomplete");
  }
  if (candidateSet.coverage.unresolvedAmbiguities.length > 0) {
    reasons.push("unresolved_ambiguities_present");
  }
  const distance = Math.max(0, maxCandidateRisk - options.candidateMax)
    + Math.max(0, options.convergenceMin - scores.convergence)
    + Math.max(0, options.coverageMin - scores.coverage)
    + (candidateSet.coverage.complete ? 0 : 1)
    + candidateSet.coverage.unresolvedAmbiguities.length;
  return { passed: reasons.length === 0, reasons, maxCandidateRisk, distance };
}

function chooseDecision(gate, scores, options) {
  const improved = options.previousDistance === undefined
    || gate.distance < options.previousDistance - options.progressEpsilon;
  const stagnantRounds = improved ? 0 : options.stagnantRounds + 1;
  const fixCandidateIds = Object.entries(scores.candidateRisks)
    .filter(([, risk]) => risk > options.candidateMax)
    .map(([id]) => id);
  if (gate.passed) {
    return {
      decision: "skip_codex",
      reason: "all_gate_conditions_passed",
      improved,
      stagnantRounds,
      fixCandidateIds,
    };
  }
  if (stagnantRounds >= DEFAULTS.stagnationRounds) {
    return {
      decision: "run_codex",
      reason: "evaluation_stagnated",
      improved,
      stagnantRounds,
      fixCandidateIds,
    };
  }
  if (fixCandidateIds.length > 0) {
    return {
      decision: "fix_with_subagent",
      reason: "high_risk_candidates_present",
      improved,
      stagnantRounds,
      fixCandidateIds,
    };
  }
  return {
    decision: "refine_candidates",
    reason: "coverage_or_convergence_below_threshold",
    improved,
    stagnantRounds,
    fixCandidateIds,
  };
}

async function loadPricing() {
  try {
    const response = await fetch(MODELS_URL);
    if (!response.ok) return null;
    const models = (await response.json()).data ?? [];
    return Object.fromEntries(models.map((model) => [model.id, model.pricing ?? null]));
  } catch {
    return null;
  }
}

function tokenCount(usage, ...keys) {
  for (const key of keys) {
    if (Number.isFinite(usage?.[key])) return usage[key];
  }
  return 0;
}

function estimateCost(rounds, pricing, options) {
  if (!pricing?.[options.evaluatorModel]) return null;
  let total = 0;
  for (const round of rounds) {
    total += tokenCount(round.evaluatorUsage, "inputTokens", "input_tokens")
      * Number(pricing[options.evaluatorModel].input ?? 0);
    total += tokenCount(round.evaluatorUsage, "outputTokens", "output_tokens")
      * Number(pricing[options.evaluatorModel].output ?? 0);
  }
  return total;
}

function selfTest() {
  const candidates = {
    coverage: { complete: true, unresolvedAmbiguities: [] },
  };
  const pass = evaluateGate(
    candidates,
    {
      candidateRisks: { C1: 0.06, C2: 0.09 },
      convergence: 0.91,
      coverage: 0.94,
    },
    DEFAULTS,
  );
  const fail = evaluateGate(
    candidates,
    { candidateRisks: { C1: 0.82 }, convergence: 0.23, coverage: 0.95 },
    DEFAULTS,
  );
  if (!pass.passed || fail.passed || fail.reasons.length !== 2) {
    throw new Error("gate self-test failed");
  }
  const fix = chooseDecision(fail, { candidateRisks: { C1: 0.82 } }, {
    ...DEFAULTS,
    round: 1,
    stagnantRounds: 0,
  });
  const refineGate = evaluateGate(
    candidates,
    { candidateRisks: { C1: 0.06 }, convergence: 0.67, coverage: 0.58 },
    DEFAULTS,
  );
  const refine = chooseDecision(refineGate, { candidateRisks: { C1: 0.06 } }, {
    ...DEFAULTS,
    round: 1,
    stagnantRounds: 0,
  });
  const stagnated = chooseDecision(refineGate, { candidateRisks: { C1: 0.06 } }, {
    ...DEFAULTS,
    round: 3,
    previousDistance: refineGate.distance,
    stagnantRounds: 1,
  });
  if (fix.decision !== "fix_with_subagent"
    || refine.decision !== "refine_candidates"
    || stagnated.decision !== "run_codex") {
    throw new Error("decision self-test failed");
  }
  return { ok: true, pass, fail, decisions: { fix, refine, stagnated } };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  if (!options.authorized) {
    console.log(JSON.stringify(failOpen("external_transfer_not_authorized"), null, 2));
    return;
  }
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify(failOpen("missing_ai_gateway_api_key"), null, 2));
    return;
  }
  if (!options.worktree || !options.candidates || (!options.input && !options.prUrl)) {
    throw new Error("provide --worktree, --candidates, and either --input or --pr");
  }
  const worktree = path.resolve(options.worktree);
  const context = options.input
    ? JSON.parse(await readFile(options.input, "utf8"))
    : await collectContext(options.prUrl, worktree);
  const candidateSet = await loadCandidates(options.candidates);
  const stateCharacters = JSON.stringify(context).length + JSON.stringify(candidateSet).length;
  if (stateCharacters > options.maxInputCharacters) {
    console.log(JSON.stringify(failOpen("input_too_large", {
      stateCharacters,
      maxInputCharacters: options.maxInputCharacters,
    }), null, 2));
    return;
  }
  const frozenHead = context.pr?.headOid;
  if (!frozenHead || !/^[0-9a-f]{40}$/i.test(frozenHead)) {
    throw new Error("input is missing a full headOid");
  }
  const frozenContextDigest = contextDigest(context);
  const pricing = await loadPricing();
  const scores = await scoreCandidates(candidateSet, context, options, apiKey);
  const gate = evaluateGate(candidateSet, scores, options);
  const decisionResult = chooseDecision(gate, scores, options);
  const rounds = [{
    round: options.round,
    candidates: candidateSet,
    scores: {
      candidateRisks: scores.candidateRisks,
      convergence: scores.convergence,
      coverage: scores.coverage,
    },
    gate,
    evaluatorUsage: scores.usage,
    providerMetadata: scores.providerMetadata,
  }];
  if (options.prUrl) {
    const latestContext = await collectContext(options.prUrl, worktree);
    const latestHead = latestContext.pr?.headOid;
    const latestContextDigest = contextDigest(latestContext);
    if (latestHead !== frozenHead || latestContextDigest !== frozenContextDigest) {
      console.log(JSON.stringify(failOpen("review_context_changed_during_evaluation", {
        headOid: frozenHead,
        latestHead,
        contextDigest: frozenContextDigest,
        latestContextDigest,
        rounds,
      }), null, 2));
      return;
    }
  }
  console.log(JSON.stringify({
    version: 1,
    decision: decisionResult.decision,
    reason: decisionResult.reason,
    headOid: frozenHead,
    baseRef: context.pr?.baseRef ?? null,
    baseOid: context.pr?.baseOid ?? null,
    contextDigest: frozenContextDigest,
    thresholds: {
      candidateMax: options.candidateMax,
      convergenceMin: options.convergenceMin,
      coverageMin: options.coverageMin,
    },
    models: {
      candidate: "caller_agent",
      evaluator: options.evaluatorModel,
    },
    stateCharacters,
    roundState: {
      round: options.round,
      distance: gate.distance,
      improved: decisionResult.improved,
      stagnantRounds: decisionResult.stagnantRounds,
      fixCandidateIds: decisionResult.fixCandidateIds,
    },
    rounds,
    usage: rounds.map(({ round, evaluatorUsage }) => ({
      round,
      evaluator: evaluatorUsage,
    })),
    costScope: "vercel_jev",
    estimatedCostUsd: estimateCost(rounds, pricing, options),
  }, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify(failOpen("execution_error", {
    error: String(error),
  }), null, 2));
});

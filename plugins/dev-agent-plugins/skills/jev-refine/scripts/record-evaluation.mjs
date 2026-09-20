#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_FILE = path.join(
  process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"),
  "jev-refine",
  "evaluations.jsonl",
);
const DECISIONS = new Set([
  "skip_codex",
  "run_codex",
  "fix_with_subagent",
  "refine_candidates",
]);
const OUTCOME_SOURCES = new Set([
  "github_codex",
  "local_codex",
  "jev_skip",
  "usage_limit",
  "not_reached",
]);

function parseArgs(argv) {
  const options = { output: DEFAULT_FILE, selfTest: false, summaryOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--input") options.input = next();
    else if (arg === "--output") options.output = next();
    else if (arg === "--summary") options.summaryOnly = true;
    else if (arg === "--self-test") options.selfTest = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.selfTest && !options.summaryOnly && !options.input) {
    throw new Error("provide --input, --summary, or --self-test");
  }
  return options;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireHex(value, length, name) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`, "i").test(value)) {
    throw new Error(`${name} must be a ${length}-character hexadecimal value`);
  }
  return value.toLowerCase();
}

function nullableHex(value, length, name) {
  if (value === null || value === undefined) return null;
  return requireHex(value, length, name);
}

function nullableProbability(value, name) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be null or a number from 0 to 1`);
  }
  return value;
}

function nullableNonNegative(value, name, { integer = false } = {}) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be null or a non-negative${integer ? " integer" : " number"}`);
  }
  return value;
}

function canonicalPr(value) {
  const url = new URL(requireString(value, "pr.url"));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("pr.url must be a canonical HTTPS pull request URL without credentials, query, or fragment");
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
  if (!match) throw new Error("pr.url must be a canonical pull request URL");
  return {
    url: url.toString().replace(/\/$/, ""),
    host: url.hostname.toLowerCase(),
    repository: `${match[1]}/${match[2]}`,
    number: Number(match[3]),
  };
}

function sanitiseEvaluation(value) {
  if (!value || typeof value !== "object") throw new Error("evaluation must be an object");
  const pr = canonicalPr(value.pr?.url);
  const decision = requireString(value.gate?.decision, "gate.decision");
  if (!DECISIONS.has(decision)) throw new Error("gate.decision is invalid");
  const outcomeSource = requireString(value.outcome?.source, "outcome.source");
  if (!OUTCOME_SOURCES.has(outcomeSource)) throw new Error("outcome.source is invalid");
  const actionableFindings = nullableNonNegative(
    value.outcome?.actionableFindings,
    "outcome.actionableFindings",
    { integer: true },
  );
  const codexExecuted = value.outcome?.codexExecuted === true;
  if (codexExecuted !== (outcomeSource === "github_codex" || outcomeSource === "local_codex")) {
    throw new Error("outcome.codexExecuted and outcome.source are inconsistent");
  }
  if (!codexExecuted && actionableFindings !== null) {
    throw new Error("actionableFindings requires an executed Codex review");
  }
  if (codexExecuted && actionableFindings === null) {
    throw new Error("an executed Codex review requires actionableFindings");
  }
  const round = nullableNonNegative(value.gate?.round, "gate.round", { integer: true });
  if (round === null || round < 1) throw new Error("gate.round must be a positive integer");
  const headOid = requireHex(value.headOid, 40, "headOid");
  const baseOid = requireHex(value.baseOid, 40, "baseOid");
  const contextDigest = nullableHex(value.contextDigest, 64, "contextDigest");
  const observed = codexExecuted;
  const actualSafeToSkip = observed ? actionableFindings === 0 : null;
  const predictedSafeToSkip = decision === "skip_codex";
  const maxCandidateRisk = nullableProbability(value.gate?.maxCandidateRisk, "gate.maxCandidateRisk");
  const coverage = nullableProbability(value.gate?.coverage, "gate.coverage");
  const convergence = nullableProbability(value.gate?.convergence, "gate.convergence");
  const evaluablePrediction = contextDigest !== null
    && maxCandidateRisk !== null
    && coverage !== null
    && convergence !== null
    && (decision === "skip_codex" || decision === "run_codex");
  const evaluationId = createHash("sha256")
    .update([pr.url, headOid, contextDigest ?? "unavailable", round].join("\n"))
    .digest("hex");
  return {
    schemaVersion: 1,
    evaluationId,
    recordedAt: new Date().toISOString(),
    pr,
    headOid,
    baseOid,
    contextDigest,
    gate: {
      decision,
      reason: requireString(value.gate?.reason, "gate.reason"),
      round,
      maxCandidateRisk,
      coverage,
      convergence,
      distance: nullableNonNegative(value.gate?.distance, "gate.distance"),
      estimatedCostUsd: nullableNonNegative(value.gate?.estimatedCostUsd, "gate.estimatedCostUsd"),
    },
    outcome: {
      source: outcomeSource,
      codexExecuted,
      actionableFindings,
      labelStatus: observed ? "observed" : "unlabelled",
    },
    calibration: {
      predictedSafeToSkip,
      actualSafeToSkip,
      eligible: observed && evaluablePrediction,
      correct: observed && evaluablePrediction
        ? predictedSafeToSkip === actualSafeToSkip
        : null,
    },
    candidateValidation: {
      confirmed: nullableNonNegative(value.candidateValidation?.confirmed, "candidateValidation.confirmed", { integer: true }),
      rejected: nullableNonNegative(value.candidateValidation?.rejected, "candidateValidation.rejected", { integer: true }),
      unresolved: nullableNonNegative(value.candidateValidation?.unresolved, "candidateValidation.unresolved", { integer: true }),
    },
  };
}

function latestRecords(records) {
  const latest = new Map();
  for (const record of records) latest.set(record.evaluationId, record);
  return [...latest.values()];
}

function summarise(records) {
  const latest = latestRecords(records);
  const eligible = latest.filter((record) => record.calibration?.eligible);
  const labelledSkip = eligible.filter((record) => record.calibration.predictedSafeToSkip);
  const convergencePairs = eligible.filter((record) => Number.isFinite(record.gate?.convergence));
  const counts = {
    safeSkip: 0,
    falseApproval: 0,
    conservativeCorrect: 0,
    unnecessaryEscalation: 0,
  };
  for (const record of eligible) {
    if (record.calibration.predictedSafeToSkip && record.calibration.actualSafeToSkip) counts.safeSkip += 1;
    else if (record.calibration.predictedSafeToSkip) counts.falseApproval += 1;
    else if (!record.calibration.actualSafeToSkip) counts.conservativeCorrect += 1;
    else counts.unnecessaryEscalation += 1;
  }
  const correct = counts.safeSkip + counts.conservativeCorrect;
  const labelledCount = latest.filter((record) => record.outcome?.labelStatus === "observed").length;
  const skipPredictions = latest.filter((record) => record.calibration?.predictedSafeToSkip).length;
  const brierScore = convergencePairs.length === 0 ? null : convergencePairs.reduce((sum, record) => {
    const actual = record.calibration.actualSafeToSkip ? 1 : 0;
    return sum + (record.gate.convergence - actual) ** 2;
  }, 0) / convergencePairs.length;
  return {
    uniqueEvaluations: latest.length,
    labelled: labelledCount,
    unlabelled: latest.filter((record) => record.outcome?.labelStatus !== "observed").length,
    labelCoverage: latest.length === 0 ? null : labelledCount / latest.length,
    skipPredictions,
    labelledSkipPredictions: labelledSkip.length,
    skipLabelCoverage: skipPredictions === 0 ? null : labelledSkip.length / skipPredictions,
    confusion: counts,
    observedAccuracy: eligible.length === 0 ? null : correct / eligible.length,
    falseApprovalRate: labelledSkip.length === 0 ? null : counts.falseApproval / labelledSkip.length,
    convergenceBrierScore: brierScore,
    warning: skipPredictions > 0 && labelledSkip.length < skipPredictions
      ? "false-approval metrics cover only skip decisions with an observed Codex label"
      : null,
  };
}

async function readRecords(file) {
  try {
    const text = await readFile(file, "utf8");
    return text.split("\n").filter(Boolean).map((line, index) => {
      try {
        const record = JSON.parse(line);
        if (record?.schemaVersion !== 1
          || !/^[0-9a-f]{64}$/i.test(record?.evaluationId ?? "")
          || typeof record?.calibration !== "object"
          || typeof record?.outcome !== "object") {
          throw new Error("unsupported or malformed evaluation record");
        }
        return record;
      } catch (error) {
        throw new Error(`invalid JSONL at line ${index + 1}: ${error}`);
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function acquireLock(file) {
  const lockFile = `${file}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      return { handle, lockFile };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const lockStat = await stat(lockFile);
        if (Date.now() - lockStat.mtimeMs > 60_000) await unlink(lockFile);
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`could not acquire evaluation log lock: ${lockFile}`);
}

async function appendEvaluations(file, evaluations) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lock = await acquireLock(file);
  try {
    const existing = await readRecords(file);
    const latest = new Map(latestRecords(existing).map((record) => [record.evaluationId, record]));
    const appended = [];
    const unchanged = [];
    for (const evaluation of evaluations) {
      const previous = latest.get(evaluation.evaluationId);
      const comparable = (record) => {
        const { recordedAt: _recordedAt, revision: _revision,
          supersedesPrevious: _supersedesPrevious, ...stable } = record;
        return JSON.stringify(stable);
      };
      if (previous && comparable(previous) === comparable(evaluation)) {
        unchanged.push(evaluation.evaluationId);
        continue;
      }
      appended.push({
        ...evaluation,
        revision: previous ? (previous.revision ?? 1) + 1 : 1,
        supersedesPrevious: Boolean(previous),
      });
      latest.set(evaluation.evaluationId, appended.at(-1));
    }
    if (appended.length > 0) {
      await appendFile(file, `${appended.map((record) => JSON.stringify(record)).join("\n")}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    await chmod(file, 0o600);
    return { appended, unchanged, records: [...existing, ...appended] };
  } finally {
    await lock.handle.close();
    await unlink(lock.lockFile).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function selfTest() {
  const base = {
    pr: { url: "https://github.com/example/repo/pull/1" },
    headOid: "1".repeat(40),
    baseOid: "0".repeat(40),
    contextDigest: "a".repeat(64),
    gate: {
      decision: "run_codex",
      reason: "evaluation_stagnated",
      round: 3,
      maxCandidateRisk: 0.04,
      coverage: 0.64,
      convergence: 0.73,
      distance: 0.43,
      estimatedCostUsd: 0.005,
    },
    outcome: { source: "github_codex", codexExecuted: true, actionableFindings: 0 },
    candidateValidation: { confirmed: 0, rejected: 1, unresolved: 0 },
  };
  const recorded = sanitiseEvaluation(base);
  const summary = summarise([recorded]);
  if (summary.confusion.unnecessaryEscalation !== 1 || summary.observedAccuracy !== 0) {
    throw new Error("evaluation summary self-test failed");
  }
  const unlabelled = sanitiseEvaluation({
    ...base,
    gate: { ...base.gate, decision: "skip_codex", reason: "all_gate_conditions_passed" },
    outcome: { source: "jev_skip", codexExecuted: false, actionableFindings: null },
  });
  const unlabelledSummary = summarise([unlabelled]);
  if (unlabelledSummary.labelled !== 0 || unlabelledSummary.falseApprovalRate !== null) {
    throw new Error("unlabelled skip self-test failed");
  }
  return { ok: true, observed: summary, unlabelled: unlabelledSummary };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) {
    console.log(JSON.stringify(selfTest(), null, 2));
    return;
  }
  const output = path.resolve(options.output);
  if (options.summaryOnly) {
    console.log(JSON.stringify({ file: output, summary: summarise(await readRecords(output)) }, null, 2));
    return;
  }
  const input = JSON.parse(await readFile(options.input, "utf8"));
  const rawEvaluations = Array.isArray(input.evaluations) ? input.evaluations : [input];
  if (rawEvaluations.length === 0) throw new Error("input contains no evaluations");
  const evaluations = rawEvaluations.map(sanitiseEvaluation);
  const result = await appendEvaluations(output, evaluations);
  console.log(JSON.stringify({
    file: output,
    appendedEvaluationIds: result.appended.map((record) => record.evaluationId),
    unchangedEvaluationIds: result.unchanged,
    summary: summarise(result.records),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exitCode = 1;
});

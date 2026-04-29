import { query } from "@anthropic-ai/claude-agent-sdk";
import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import { aggregateUsageFromResult, EMPTY_USAGE, type UsageTotals } from "./usage.js";

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const PROPOSER_PROMPT = `You are a memory-consolidation proposer.

Given a list of the user's active memories (each tagged with its segment — identity, correction, preference, relationship, project, knowledge, or context), find cases where memories should be:
- merged: multiple entries say the same durable fact in different words
- superseded: a newer memory replaces an older one with a conflicting value
- pruned: an entry is redundant given stronger ones, or obviously wrong

Return STRICT JSON only:
{"proposals":[
  {"type":"merge","keep":"mem_...","absorb":["mem_...","mem_..."],"rewriteContent":"..."},
  {"type":"supersede","newer":"mem_...","older":["mem_..."]},
  {"type":"prune","memoryId":"mem_...","reason":"..."}
]}

Hard rules:
- NEVER propose a merge with an empty "absorb" list. If there's nothing to
  absorb, there's nothing to merge — skip it entirely.
- "absorb" MUST NOT contain the same id as "keep".
- "rewriteContent" must be a single clear sentence combining both sources.
- Be conservative on DISTINCT facts — similar but distinct facts stay separate.

Segment-aware rules:
- A memory tagged "correction" is the user FIXING something they previously said or something in your memory. When a correction contradicts an older fact about the same subject, propose a "supersede" with the correction as "newer" and the contradicted fact(s) as "older". Correction almost always wins.
- Never merge a correction into a non-correction. If you keep just one, keep the correction.
- Identity memories (name, role, location) are high-priority. Only supersede an identity with another identity or a correction that clearly updates it.
- Context memories are low-priority and short-lived — prefer prune over merge for context clutter.

If no changes needed, return {"proposals":[]}. Respond with ONLY the JSON.`;

const ADVERSARY_PROMPT = `You are a memory-consolidation adversary. A proposer has suggested changes to the user's memory (each tagged with segment: identity, correction, preference, relationship, project, knowledge, or context). Your job is to find reasons each proposal could be WRONG or harmful before a judge rules on them.

For each proposal, look for:
- merges that would blur genuinely distinct facts
- supersedes where the "newer" memory doesn't actually cover everything the "older" one said
- prunes that would remove a fact that's rare or harder to rediscover than it looks
- any loss of context, specificity, source info, or nuance

Segment-aware skepticism:
- If a correction is being superseded by a non-correction, flag it — that's almost always wrong. Corrections are durable.
- If an identity memory is being merged or pruned, verify it's clearly redundant — identity facts are expensive to recover.
- If a correction supersede looks aggressive (removing useful context along with the wrong part), flag the context loss.

Be sharp but fair. If a proposal looks clean, say so — don't manufacture objections. Your objections inform the judge; you don't decide.

Return STRICT JSON only. Each challenge MUST include an entry for every proposal index. Shape:
{"challenges":[
  {"proposalIndex":0,"objection":"merging these loses the distinction between X and Y","severity":"high"},
  {"proposalIndex":1,"objection":null,"severity":"low"}
]}

Rules for the fields:
- "severity" MUST be exactly one of the strings: "low", "medium", "high".
- "objection" is either a plain string describing the concern, or the JSON literal null (not the string "null") when you have no objection.
- Use "low" for nitpicks, "medium" for real concerns, "high" for real information loss.

Respond with ONLY the JSON object.`;

const JUDGE_PROMPT = `You are a memory-consolidation judge. You see a proposer's suggested changes AND an adversary's objections to each. Weigh both sides and rule.

Return STRICT JSON only:
{"decisions":[
  {"proposalIndex":0,"approve":true,"rationale":"..."},
  {"proposalIndex":1,"approve":false,"rationale":"..."}
]}

Rules:
- A "high" severity adversary objection should usually result in rejection unless the proposal's benefit clearly outweighs the loss.
- "medium" objections: weigh case-by-case; often approve with the note that the judge acknowledged the concern.
- "low" objections and clean proposals: approve.
- Your rationale should cite the adversary's objection when relevant ("approved despite adversary concern about X because...").
- Respond with ONLY the JSON.`;

const COMPACTION_PROPOSER_PROMPT = `You are a conservative memory-compaction proposer.

Goal: reduce clutter by combining obviously compatible memories into fewer, richer memories. This is LESS aggressive than consolidation.

Given active memories, propose ONLY safe merges. Return STRICT JSON only:
{"proposals":[
  {"type":"merge","keep":"mem_...","absorb":["mem_..."],"rewriteContent":"..."}
]}

Hard rules:
- Only propose "merge". Do not propose supersede or prune.
- Merge only memories from the SAME segment.
- Merge at most 4 memories in one proposal.
- The rewrite must preserve every non-conflicting durable fact from every source.
- Identity facts about the same person, such as name and birthday, are complementary and SHOULD be compacted when the rewrite preserves both.
- If one memory is a correction of a single field in another memory, keep the corrected value and preserve unrelated facts. Example: "User's name is João Ricardo (corrected from Anu)." + "User's name is Anu. Birthday is September 18th." can become "User's name is João Ricardo. Birthday is September 18th."
- If one source is already a cleaner duplicate of part of the rewrite, it is still valid to absorb it. Compaction archives absorbed memories via supersedes, so source traceability is preserved.
- Prefer the most complete or highest-importance memory as "keep".
- Do not merge if the combined sentence would lose nuance, uncertainty, dates, people, project names, cadence, or constraints.
- Do not merge memories about similar but distinct subjects.
- If you are not certain the merge is lossless, skip it.

If no low-risk compaction exists, return {"proposals":[]}. Respond with ONLY the JSON.`;

const COMPACTION_ADVERSARY_PROMPT = `You are a memory-compaction adversary. A proposer suggested conservative merge-only compactions. Your job is to reject anything that might lose information.

For each proposal, look for:
- distinct facts being blurred into one vague sentence
- corrected/obsolete values accidentally preserved as current facts
- unrelated facts joined only because they share a segment
- any missing detail from the source memories
- merges that rely on guessing instead of explicit overlap
- Evaluate each proposal ONLY against its listed source memories. Other active memories are not being changed and remain active.
- Do NOT object merely because separate source memories become one record. Absorbed memories are archived via supersedes, so traceability is preserved.
- Do NOT object to compacting complementary identity facts about the same person, such as corrected name + birthday, when the rewrite keeps the corrected value and the birthday.
- Do NOT object because one absorbed memory is a cleaner duplicate of a fact already represented in the rewrite. That is useful compaction, not information loss.

Return STRICT JSON only. Each challenge MUST include an entry for every proposal index:
{"challenges":[
  {"proposalIndex":0,"objection":"the rewrite drops the Thursday schedule","severity":"high"},
  {"proposalIndex":1,"objection":null,"severity":"low"}
]}

Use "high" only for concrete missing or incorrect facts. Use "medium" for real uncertainty about whether facts refer to the same subject. Use "low" when the compaction is clearly lossless.
Respond with ONLY the JSON object.`;

const COMPACTION_JUDGE_PROMPT = `You are a conservative memory-compaction judge. You see merge-only compaction proposals and adversary objections.

Approve only when the merge is clearly lossless and less cluttered than the originals.

Return STRICT JSON only:
{"decisions":[
  {"proposalIndex":0,"approve":true,"rationale":"..."},
  {"proposalIndex":1,"approve":false,"rationale":"..."}
]}

Rules:
- Reject every proposal with a high-severity objection.
- Reject medium-severity objections unless the source memories explicitly prove the rewrite preserves all facts.
- Ignore objections about memories that are not listed as source memories for that proposal; those memories remain active.
- Reject if the proposal merges different segments, has no absorbed memory, or the rewrite is vague.
- Approve only if the rewrite keeps all non-conflicting facts and uses corrected values when a source clearly corrects another.
- Do not reject solely for source traceability concerns: absorbed records are archived through supersedes.
- Approve compacting complementary identity facts about the same person, such as corrected name + birthday, when the rewrite preserves both and drops only obsolete corrected-from values as current facts.
- Respond with ONLY the JSON.`;

interface Proposal {
  type: "merge" | "supersede" | "prune";
  keep?: string;
  absorb?: string[];
  rewriteContent?: string;
  newer?: string;
  older?: string[];
  memoryId?: string;
  reason?: string;
}

interface Challenge {
  proposalIndex: number;
  objection: string | null;
  severity: "low" | "medium" | "high";
}

const ADVERSARY_MODEL = process.env.BOOP_ADVERSARY_MODEL ?? "claude-haiku-4-5";
const DEFAULT_MODEL = process.env.BOOP_MODEL ?? "claude-sonnet-4-6";

interface Decision {
  proposalIndex: number;
  approve: boolean;
  rationale: string;
}

interface Applied {
  proposalIndex: number;
  type: "merge" | "supersede" | "prune";
  summary: string;
}

interface MemoryForConsolidation {
  memoryId: string;
  content: string;
  tier: "short" | "long" | "permanent";
  segment:
    | "identity"
    | "preference"
    | "correction"
    | "relationship"
    | "project"
    | "knowledge"
    | "context";
  importance: number;
  decayRate: number;
  accessCount: number;
  lastAccessedAt: number;
  createdAt: number;
  metadata?: string;
}

interface ConsolidationModeConfig {
  mode: "consolidation" | "compaction";
  minimumMemories: number;
  proposerPrompt: string;
  adversaryPrompt: string;
  judgePrompt: string;
  adversaryModel: string;
}

async function runLlm(
  systemPrompt: string,
  userPrompt: string,
  model: string = DEFAULT_MODEL,
): Promise<{ buffer: string; usage: UsageTotals; durationMs: number }> {
  const started = Date.now();
  let buffer = "";
  let usage: UsageTotals = { ...EMPTY_USAGE };
  for await (const msg of query({
    prompt: userPrompt,
    options: {
      systemPrompt,
      model,
      permissionMode: "bypassPermissions",
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") buffer += block.text;
      }
    } else if (msg.type === "result") {
      usage = aggregateUsageFromResult(msg, model);
    }
  }
  return { buffer, usage, durationMs: Date.now() - started };
}

async function recordConsolidationUsage(
  source: "consolidation-proposer" | "consolidation-adversary" | "consolidation-judge",
  runId: string,
  usage: UsageTotals,
  durationMs: number,
): Promise<void> {
  if (usage.costUsd <= 0 && usage.inputTokens <= 0) return;
  await convex.mutation(api.usageRecords.record, {
    source,
    runId,
    model: usage.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    costUsd: usage.costUsd,
    durationMs,
  });
}

function parseJson<T>(raw: string): T | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

function buildMemoryPayload(memories: MemoryForConsolidation[]): string {
  return memories
    .map((m) => {
      const ageDays = Math.round((Date.now() - m.createdAt) / 86400000);
      const prefix = `- [${m.memoryId}] (${m.tier}/${m.segment} i=${m.importance.toFixed(2)} age=${ageDays}d)`;
      // Surface correction metadata inline so the LLM sees what was being
      // corrected without having to infer it from content alone.
      let suffix = "";
      if (m.segment === "correction" && m.metadata) {
        try {
          const meta = JSON.parse(m.metadata) as { corrects?: string };
          if (meta.corrects) {
            // Strip `]` and collapse whitespace so user-supplied text
            // can't break the `[corrects: ...]` annotation format that
            // proposer/adversary prompts rely on, and can't inject a
            // fake second memory entry via embedded newlines.
            const safe = meta.corrects
              .replace(/[\r\n]+/g, " ")
              .replace(/\]/g, "")
              .trim()
              .slice(0, 300);
            if (safe) suffix = ` [corrects: ${safe}]`;
          }
        } catch {
          /* metadata not JSON — ignore */
        }
      }
      return `${prefix} ${m.content}${suffix}`;
    })
    .join("\n");
}

function sanitizeCompactionProposals(
  proposals: Proposal[],
  memories: MemoryForConsolidation[],
): Proposal[] {
  const byId = new Map(memories.map((m) => [m.memoryId, m]));
  return proposals.filter((p) => {
    if (p.type !== "merge") return false;
    if (
      typeof p.keep !== "string" ||
      !Array.isArray(p.absorb) ||
      p.absorb.length === 0 ||
      typeof p.rewriteContent !== "string" ||
      !p.rewriteContent.trim()
    ) {
      return false;
    }
    if (p.absorb.length > 3) return false;
    if (p.absorb.includes(p.keep)) return false;
    const keep = byId.get(p.keep);
    if (!keep) return false;
    const absorbed = p.absorb.map((id) => byId.get(id));
    if (absorbed.some((m) => !m)) return false;
    return absorbed.every((m) => m?.segment === keep.segment);
  });
}

function proposalMemoryIds(proposal: Proposal): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") ids.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) add(item);
    }
  };
  add(proposal.keep);
  add(proposal.absorb);
  add(proposal.newer);
  add(proposal.older);
  add(proposal.memoryId);
  return [...ids];
}

function buildCompactionReviewPayload(
  proposals: Proposal[],
  memories: MemoryForConsolidation[],
): string {
  const byId = new Map(memories.map((m) => [m.memoryId, m]));
  return proposals
    .map((proposal, index) => {
      const sourceMemories = proposalMemoryIds(proposal)
        .map((id) => byId.get(id))
        .filter((memory): memory is MemoryForConsolidation => Boolean(memory));
      return [
        `Proposal #${index} source memories:`,
        "Only these records are being rewritten or archived. All other active memories remain active.",
        buildMemoryPayload(sourceMemories),
      ].join("\n");
    })
    .join("\n\n");
}

async function runMemoryMaintenance(
  trigger: string,
  config: ConsolidationModeConfig,
): Promise<{
  runId: string;
  proposals: number;
  merged: number;
  pruned: number;
}> {
  const runId = randomId("cons");
  await convex.mutation(api.consolidation.createRun, { runId, trigger });
  broadcast("consolidation_started", { runId, trigger });

  let merged = 0;
  let pruned = 0;

  try {
    const memories: MemoryForConsolidation[] = await convex.query(api.memoryRecords.list, {
      lifecycle: "active",
      limit: 150,
    });
    broadcast("consolidation_phase", { runId, phase: "loaded", memoriesCount: memories.length });
    if (memories.length < config.minimumMemories) {
      await convex.mutation(api.consolidation.updateRun, {
        runId,
        status: "completed",
        notes: `not enough memories to ${config.mode}`,
      });
      return { runId, proposals: 0, merged: 0, pruned: 0 };
    }

    const payload = buildMemoryPayload(memories);

    broadcast("consolidation_phase", { runId, phase: "proposing" });
    const proposerCall = await runLlm(config.proposerPrompt, payload);
    await recordConsolidationUsage(
      "consolidation-proposer",
      runId,
      proposerCall.usage,
      proposerCall.durationMs,
    );
    const proposerJson = parseJson<{ proposals: Proposal[] }>(proposerCall.buffer);
    const proposals =
      config.mode === "compaction"
        ? sanitizeCompactionProposals(proposerJson?.proposals ?? [], memories)
        : (proposerJson?.proposals ?? []);
    broadcast("consolidation_phase", {
      runId,
      phase: "proposed",
      proposalsCount: proposals.length,
      proposals,
    });

    await convex.mutation(api.consolidation.updateRun, {
      runId,
      proposalsCount: proposals.length,
    });

    if (proposals.length === 0) {
      await convex.mutation(api.consolidation.updateRun, {
        runId,
        status: "completed",
        notes: "no proposals",
      });
      return { runId, proposals: 0, merged: 0, pruned: 0 };
    }

    const proposalsList = proposals
      .map((p, i) => `#${i}: ${JSON.stringify(p)}`)
      .join("\n");
    const reviewPayload =
      config.mode === "compaction"
        ? buildCompactionReviewPayload(proposals, memories)
        : payload;

    broadcast("consolidation_phase", { runId, phase: "challenging" });
    const adversaryPayload = `Proposals:\n${proposalsList}\n\nSource memories:\n${reviewPayload}`;
    const adversaryCall = await runLlm(
      config.adversaryPrompt,
      adversaryPayload,
      config.adversaryModel,
    );
    await recordConsolidationUsage(
      "consolidation-adversary",
      runId,
      adversaryCall.usage,
      adversaryCall.durationMs,
    );
    const adversaryJson = parseJson<{ challenges: Challenge[] }>(adversaryCall.buffer);
    const challenges = adversaryJson?.challenges ?? [];
    broadcast("consolidation_phase", {
      runId,
      phase: "challenged",
      challengesCount: challenges.length,
      challenges,
    });

    const challengesByIndex = new Map(challenges.map((c) => [c.proposalIndex, c]));
    const challengesBlock = proposals
      .map((_p, i) => {
        const c = challengesByIndex.get(i);
        if (!c || !c.objection) return `#${i}: adversary raised no objection`;
        return `#${i}: [${c.severity}] ${c.objection}`;
      })
      .join("\n");

    const judgePayload = `Proposals:\n${proposalsList}\n\nAdversary challenges:\n${challengesBlock}\n\nSource memories:\n${reviewPayload}`;

    broadcast("consolidation_phase", { runId, phase: "judging" });
    const judgeCall = await runLlm(config.judgePrompt, judgePayload);
    await recordConsolidationUsage(
      "consolidation-judge",
      runId,
      judgeCall.usage,
      judgeCall.durationMs,
    );
    const judgeJson = parseJson<{
      decisions: { proposalIndex: number; approve: boolean; rationale: string }[];
    }>(judgeCall.buffer);
    const decisions = judgeJson?.decisions ?? [];
    const approved = new Set(
      decisions.filter((d) => d.approve).map((d) => d.proposalIndex),
    );
    broadcast("consolidation_phase", {
      runId,
      phase: "judged",
      approvedCount: approved.size,
      rejectedCount: decisions.length - approved.size,
      decisions,
    });

    const applied: Applied[] = [];
    broadcast("consolidation_phase", { runId, phase: "applying" });
    for (let i = 0; i < proposals.length; i++) {
      if (!approved.has(i)) continue;
      const p = proposals[i];
      try {
        if (p.type === "merge" && p.keep && p.absorb?.length && p.rewriteContent) {
          const keep = memories.find((m) => m.memoryId === p.keep);
          if (!keep) continue;
          await convex.mutation(api.memoryRecords.upsert, {
            memoryId: keep.memoryId,
            content: p.rewriteContent,
            tier: keep.tier,
            segment: keep.segment,
            importance: keep.importance,
            decayRate: keep.decayRate,
            supersedes: p.absorb,
          });
          merged++;
          applied.push({
            proposalIndex: i,
            type: "merge",
            summary: `merged ${p.absorb.length} into ${p.keep}`,
          });
        } else if (p.type === "supersede" && p.newer && p.older?.length) {
          const newer = memories.find((m) => m.memoryId === p.newer);
          if (!newer) continue;
          await convex.mutation(api.memoryRecords.upsert, {
            memoryId: newer.memoryId,
            content: newer.content,
            tier: newer.tier,
            segment: newer.segment,
            importance: newer.importance,
            decayRate: newer.decayRate,
            supersedes: p.older,
          });
          merged++;
          applied.push({
            proposalIndex: i,
            type: "supersede",
            summary: `${p.newer} supersedes ${p.older.length} older`,
          });
        } else if (p.type === "prune" && p.memoryId) {
          await convex.mutation(api.memoryRecords.setLifecycle, {
            memoryId: p.memoryId,
            lifecycle: "pruned",
          });
          pruned++;
          applied.push({
            proposalIndex: i,
            type: "prune",
            summary: `pruned ${p.memoryId}`,
          });
        }
      } catch (err) {
        console.warn("[consolidation] apply failed", err);
      }
    }

    await convex.mutation(api.consolidation.updateRun, {
      runId,
      status: "completed",
      mergedCount: merged,
      prunedCount: pruned,
      details: JSON.stringify({
        mode: config.mode,
        memoriesScanned: memories.length,
        proposals,
        challenges,
        decisions,
        applied,
      }),
    });
    await convex.mutation(api.memoryEvents.emit, {
      eventType: "memory.consolidated",
      data: JSON.stringify({ runId, proposals: proposals.length, merged, pruned }),
    });
    broadcast("consolidation_completed", { runId, merged, pruned });
    return { runId, proposals: proposals.length, merged, pruned };
  } catch (err) {
    await convex.mutation(api.consolidation.updateRun, {
      runId,
      status: "failed",
      notes: String(err),
    });
    broadcast("consolidation_failed", { runId, error: String(err) });
    throw err;
  }
}

export async function runConsolidation(trigger = "scheduled"): Promise<{
  runId: string;
  proposals: number;
  merged: number;
  pruned: number;
}> {
  return await runMemoryMaintenance(trigger, {
    mode: "consolidation",
    minimumMemories: 6,
    proposerPrompt: PROPOSER_PROMPT,
    adversaryPrompt: ADVERSARY_PROMPT,
    judgePrompt: JUDGE_PROMPT,
    adversaryModel: ADVERSARY_MODEL,
  });
}

export async function runCompaction(trigger = "compact-manual"): Promise<{
  runId: string;
  proposals: number;
  merged: number;
  pruned: number;
}> {
  return await runMemoryMaintenance(trigger, {
    mode: "compaction",
    minimumMemories: 2,
    proposerPrompt: COMPACTION_PROPOSER_PROMPT,
    adversaryPrompt: COMPACTION_ADVERSARY_PROMPT,
    judgePrompt: COMPACTION_JUDGE_PROMPT,
    adversaryModel: ADVERSARY_MODEL,
  });
}

export function startConsolidationLoop(intervalMs = 24 * 60 * 60 * 1000): () => void {
  const timer = setInterval(() => {
    runConsolidation("scheduled").catch((err) =>
      console.error("[consolidation] loop error", err),
    );
  }, intervalMs);
  return () => clearInterval(timer);
}

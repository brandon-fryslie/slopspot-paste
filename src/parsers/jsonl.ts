import type { Turn, ToolOutput, ToolOutputKind, Usage, SubagentTranscript } from "../types";
import { isNonEmptyTurns } from "../types";

// [LAW:types-are-the-program] Input is a Claude Code session JSONL — one
// typed event per line. Output is the same Turn[] union every other parser
// produces. Because the JSONL is *already structured*, this is the cleanest
// parser of the lot: walk discriminators, emit Turns, pair tool_use/result
// by id. No regex matching, no marker hunting, no inference.
//
// [LAW:single-enforcer] The JSONL schema lives in exactly one place — this
// file. The skill that uploads the JSONL knows zero about its shape; if
// Claude Code changes the schema, only this parser changes.
//
// Subagent (Agent/Task) runs: the current CC format stores each subagent's
// transcript in a SEPARATE sibling file (subagents/agent-<agentId>.jsonl), not
// inline. The uploader concatenates those files onto the main JSONL, so the
// stored original is one blob where subagent lines self-identify by a top-level
// `agentId` (and `isSidechain:true`). This parser groups lines by `agentId`,
// then reattaches each subagent group to its spawning Agent tool-call via the
// tool_result's top-level `toolUseResult.agentId` — an explicit id join, never
// positional [LAW:no-silent-failure]. A blob with no subagent lines (an old
// upload, or a session with no subagents) parses exactly as before, and an
// Agent call whose group is absent degrades to a summary-only subagent turn.
//
// ORPHAN subagents (slash-command / skill background runs like /recap) have a
// group but NO spawning Agent tool_result, so their type/description can't come
// from the main stream. That identity lives in a sibling agent-<id>.meta.json the
// uploader folds onto the group's OWN first sidechain line ({agentType,
// description} as top-level fields). The orphan branch reads it from there; an
// old upload predating the fold carries neither and yields honest nulls.

// Mirror the cc.ts mapping so tool outputs render identically across kinds.
// Kept local rather than imported so jsonl.ts doesn't fan-out to cc.ts.
const TOOL_OUTPUT_KIND: ReadonlyMap<string, ToolOutputKind> = new Map([
  ["Bash", "terminal"],
  ["Shell", "terminal"],
  ["Read", "file-read"],
  ["NotebookRead", "file-read"],
  ["Update", "diff"],
  ["Edit", "diff"],
  ["Write", "diff"],
  ["MultiEdit", "diff"],
]);

const outputKindFor = (tool: string): ToolOutputKind =>
  TOOL_OUTPUT_KIND.get(tool) ?? "generic";

// Minimal structural types for the JSONL events we actually read. Anything
// not represented here is ignored at the boundary; we don't carry it through.
interface TextBlock { readonly type: "text"; readonly text: string }
interface ThinkingBlock { readonly type: "thinking"; readonly thinking: string }
interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}
interface ToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  // The source's structured pass/fail signal. Absent on success in many records,
  // so it is optional; `=== true` below is the single point that reads it.
  readonly is_error?: boolean;
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { readonly type: string };

interface MessageEvent {
  readonly type: "user" | "assistant";
  // Top-level linkage the subagent reattachment reads. Subagent lines carry
  // `agentId` (and `isSidechain:true`); the Agent tool_result event carries a
  // top-level `toolUseResult` whose `agentId` joins back to the subagent group.
  // All optional: a plain main-transcript line carries none of them.
  readonly agentId?: string;
  readonly isSidechain?: boolean;
  readonly toolUseResult?: unknown;
  // The uploader folds a subagent group's sibling agent-<id>.meta.json onto the
  // group's first sidechain line as these top-level fields. Only the orphan
  // branch reads them (a tool-spawned group takes its type from the main-stream
  // tool_result instead); a line that predates the fold carries neither.
  readonly agentType?: string;
  readonly description?: string;
  readonly message?: {
    readonly id?: string;
    readonly role?: string;
    readonly content?: string | ReadonlyArray<ContentBlock>;
    readonly usage?: unknown;
  };
}

const isMessageEvent = (e: unknown): e is MessageEvent => {
  if (!e || typeof e !== "object") return false;
  const t = (e as { type?: unknown }).type;
  return t === "user" || t === "assistant";
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// A non-empty string, or null. Used for the subagent's optional identity fields
// (agentType / description / prompt) — an empty string is treated as absent.
const strOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;

// [LAW:no-silent-failure] Usage is read from the source or it is absent —
// never invented. A line without an `output_tokens` count is not a usage
// record (returns null); we do NOT default it to a zero-usage object, because
// "this message generated 0 tokens" is a different, false claim from "this
// source carries no token accounting". Sub-fields that the API genuinely omits
// (no cache used) are a real 0, so those map through `num`.
const parseUsage = (raw: unknown): Usage | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.output_tokens !== "number") return null;
  return {
    input: num(o.input_tokens),
    output: num(o.output_tokens),
    cacheCreation: num(o.cache_creation_input_tokens),
    cacheRead: num(o.cache_read_input_tokens),
  };
};

// Exported so a test building a jsonl-shaped tool-call serializes its args through
// the SAME function production uses — the test's args shape can't drift from the
// parser's [LAW:one-source-of-truth].
export const argsAsText = (input: unknown): string => {
  if (typeof input === "string") return input;
  if (input == null) return "";
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
};

// Coerce an unknown `toolUseResult.content` (a string, or an array of
// {type,text} blocks) into plain text at the trust boundary — mirrors
// resultText's contract for the structured-result field that lives one level up
// from the tool_result block.
const contentText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v
    .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter((s) => s.length > 0)
    .join("\n");
};

const resultText = (content: ToolResultBlock["content"]): string => {
  if (typeof content === "string") return content;
  // Array of content blocks — concat text fields. Non-text blocks are dropped
  // (images can't render in the existing tool-output bubble; they'd need a
  // new ToolOutputKind which is out of scope for this parser).
  return content
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter((s) => s.length > 0)
    .join("\n");
};

// Strip the structural envelope CC wraps user messages in (system reminders,
// hook output, prompt-submit annotations). The conversational substance is
// what appears OUTSIDE the <system-reminder>...</system-reminder> tags.
const stripEnvelope = (raw: string): string => {
  // Remove every <system-reminder>...</system-reminder> block (and stray
  // command-* / local-command-* envelopes). What's left is what the human
  // actually typed.
  let s = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  s = s.replace(/<(command|local-command|stdout|stderr|user-prompt-submit-hook)[^>]*>[\s\S]*?<\/\1>/g, "");
  return s.trim();
};

// [LAW:types-are-the-program] A subagent run reattached to its spawning Agent
// tool-call. Detection is by the explicit id link — the tool_result event's
// `toolUseResult.agentId` — NOT the tool's NAME (it is "Agent" now, was "Task"
// before; the id link is version-stable). Returns null when this result is a
// plain tool result (no agentId), so the caller keeps its normal tool-call.
//
// The transcript resolves to one of SubagentTranscript's two honest arms:
//   captured     — the subagent's group of lines exists in the blob and parses
//                  to a non-empty Turn[] (recursion through buildTurns).
//   summary-only — the group is absent (an old upload, or files not bundled);
//                  all the source holds is the spawn prompt and final result.
// `visited` breaks any pathological self/cyclic agentId reference so recursion
// always terminates. [LAW:no-silent-failure]
const subagentTurnFromResult = (
  toolUseResult: unknown,
  resultContent: string,
  input: unknown,
  groups: ReadonlyMap<string, MessageEvent[]>,
  visited: ReadonlySet<string>,
): Turn | null => {
  if (!isRecord(toolUseResult)) return null;
  const agentId = strOrNull(toolUseResult.agentId);
  if (agentId === null) return null;

  const inObj = isRecord(input) ? input : {};
  const agentType = strOrNull(inObj.subagent_type) ?? strOrNull(toolUseResult.agentType);
  const description = strOrNull(inObj.description);
  const prompt = strOrNull(inObj.prompt) ?? strOrNull(toolUseResult.prompt) ?? "";
  const stepCount = num(toolUseResult.totalToolUseCount);

  // The degraded result prefers the main tool_result block's text; when that is
  // empty it falls back to the source's own `toolUseResult.content` (the final
  // returned text), which carries the same value through a different field.
  const result =
    resultContent.length > 0 ? resultContent : contentText(toolUseResult.content);
  let transcript: SubagentTranscript = { kind: "summary-only", prompt, result };
  if (!visited.has(agentId)) {
    const childEvents = groups.get(agentId);
    if (childEvents && childEvents.length > 0) {
      const childTurns = buildTurns(childEvents, groups, new Set([...visited, agentId]));
      if (isNonEmptyTurns(childTurns)) transcript = { kind: "captured", turns: childTurns };
    }
  }
  return { kind: "subagent", agentType, description, stepCount, transcript };
};

// [LAW:one-source-of-truth] An orphan subagent's identity is not in any main-
// stream tool_result (it has no spawning Agent call); it rides on the group's OWN
// lines, where the uploader folds the sibling agent-<id>.meta.json's {agentType,
// description}. First line carrying each field wins. A group from an upload that
// predates the fold carries neither → honest nulls, never an invented label
// [LAW:no-silent-failure]. Tool-spawned groups never reach here (their type comes
// from the tool_result), so this is the orphan's single source of identity.
const orphanIdentity = (
  evs: ReadonlyArray<MessageEvent>,
): { readonly agentType: string | null; readonly description: string | null } => {
  let agentType: string | null = null;
  let description: string | null = null;
  for (const ev of evs) {
    agentType ??= strOrNull(ev.agentType);
    description ??= strOrNull(ev.description);
    if (agentType !== null && description !== null) break;
  }
  return { agentType, description };
};

// [LAW:dataflow-not-control-flow] Build one group's events into Turns, in source
// order. This is the whole per-transcript loop (content blocks, tool pairing,
// usage dedup) — factored out so a subagent group runs through the SAME logic as
// the main transcript [LAW:one-type-per-behavior]. Recursion happens at the Agent
// tool_result: the spawned subagent's group is built here and nested.
function buildTurns(
  events: ReadonlyArray<MessageEvent>,
  groups: ReadonlyMap<string, MessageEvent[]>,
  visited: ReadonlySet<string>,
): Turn[] {
  const turns: Turn[] = [];
  const pendingToolIndex = new Map<string, number>();
  // The raw input of each pending tool_use, kept so the tool_result can read the
  // Agent call's subagent_type/description/prompt when it converts to a subagent.
  const pendingToolInput = new Map<string, unknown>();

  // [LAW:one-source-of-truth] A logical assistant message is split across
  // several JSONL lines that each carry its usage. Those copies are not always
  // identical: early lines are PARTIAL streaming flushes (a smaller
  // output_tokens) and the settled line carries the complete count. So the
  // authoritative usage for an id is the record with the greatest output — the
  // complete generation, not a partial. This reduction owns the *value* of each
  // message's usage, keyed by id, computed once before any turn is emitted; the
  // build pass below owns only *where* the single usage Turn lands. A usage
  // record without an id can't be deduped against its siblings, so — like the
  // tool-block id guards — it is dropped at the trust boundary.
  const usageByMsgId = new Map<string, Usage>();
  for (const ev of events) {
    if (ev.type !== "assistant") continue;
    const msg = ev.message;
    if (!msg || typeof msg.id !== "string") continue;
    const usage = parseUsage(msg.usage);
    if (!usage) continue;
    const prev = usageByMsgId.get(msg.id);
    if (!prev || usage.output > prev.output) usageByMsgId.set(msg.id, usage);
  }

  // [LAW:no-silent-failure] Each message's usage is emitted exactly once as a
  // usage Turn, no matter how its lines are scattered — `emittedUsage` makes the
  // dedup GLOBAL, not just over adjacent lines. (A multi-tool message's lines
  // are interrupted by the tool_result user event between its tool calls, then
  // the SAME id resumes; a streamed message repeats across lines.) The pending
  // id is flushed at the first boundary after its content — a different message,
  // a user turn, or end of stream — pulling its authoritative value from the map.
  const emittedUsage = new Set<string>();
  let pendingMsgId: string | null = null;
  const flushUsage = (): void => {
    if (pendingMsgId !== null && !emittedUsage.has(pendingMsgId)) {
      const usage = usageByMsgId.get(pendingMsgId);
      if (usage) {
        turns.push({ kind: "usage", usage });
        emittedUsage.add(pendingMsgId);
      }
    }
    pendingMsgId = null;
  };

  for (const ev of events) {
    const msg = ev.message;
    if (!msg) {
      flushUsage();
      continue;
    }
    const role = ev.type === "user" ? "user" : "assistant";
    const msgId = typeof msg.id === "string" ? msg.id : null;

    // Another line of the SAME pending message continues it; anything else (a
    // new message, a user turn) closes the pending one out first. An id we have
    // already counted never re-arms — its usage Turn is in the stream once.
    const continuesMessage =
      role === "assistant" && msgId !== null && msgId === pendingMsgId;
    if (!continuesMessage) flushUsage();
    if (role === "assistant" && msgId !== null && !emittedUsage.has(msgId)) {
      pendingMsgId = msgId;
    }

    const content = msg.content;

    if (typeof content === "string") {
      const cleaned = role === "user" ? stripEnvelope(content) : content.trim();
      if (cleaned.length === 0) continue;
      turns.push({ kind: "message", role, content: cleaned });
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      // [LAW:no-defensive-null-guards] Legitimate trust-boundary guard: content
      // comes from JSON.parse of untrusted JSONL, so an element may be null or a
      // primitive despite the structural type. Skip it like any unknown block
      // rather than crashing on `.type`.
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        const text = (block as TextBlock).text;
        if (typeof text !== "string") continue;
        const cleaned = role === "user" ? stripEnvelope(text) : text.trim();
        if (cleaned.length === 0) continue;
        turns.push({ kind: "message", role, content: cleaned });
      } else if (block.type === "thinking") {
        // [LAW:dataflow-not-control-flow] A thinking block is a content-only Turn,
        // emitted like any other; the renderer (not this parser) decides it folds
        // collapsed. The text lives in the `thinking` field, not `text`.
        const text = (block as ThinkingBlock).thinking;
        if (typeof text !== "string") continue;
        const cleaned = text.trim();
        if (cleaned.length === 0) continue;
        turns.push({ kind: "thinking", content: cleaned });
      } else if (block.type === "tool_use") {
        const tu = block as ToolUseBlock;
        // id keys the pending-pairing map; a non-string id from untrusted input
        // would corrupt pairing, so require both fields before emitting.
        if (typeof tu.name !== "string" || typeof tu.id !== "string") continue;
        turns.push({
          kind: "tool-call",
          tool: tu.name,
          args: argsAsText(tu.input),
          output: null,
        });
        pendingToolIndex.set(tu.id, turns.length - 1);
        pendingToolInput.set(tu.id, tu.input);
      } else if (block.type === "tool_result") {
        const tr = block as ToolResultBlock;
        if (typeof tr.tool_use_id !== "string") continue;
        const idx = pendingToolIndex.get(tr.tool_use_id);
        if (idx === undefined) continue;
        const existing = turns[idx];
        if (!existing || existing.kind !== "tool-call") continue;
        const text = resultText(tr.content);
        // [LAW:dataflow-not-control-flow] An Agent tool_result carries a top-level
        // `toolUseResult.agentId`; that — not the result text or the tool name —
        // is what turns this tool-call into a subagent. When present, the call
        // BECOMES a subagent turn (replacing the tool-call in place); otherwise it
        // is a normal result paired into the call's `output`.
        const subagent = subagentTurnFromResult(
          ev.toolUseResult,
          text,
          pendingToolInput.get(tr.tool_use_id),
          groups,
          visited,
        );
        if (subagent !== null) {
          turns[idx] = subagent;
        } else {
          // [LAW:no-silent-failure] The pass/fail badge is the source's own
          // `is_error`, captured verbatim — not inferred from the result text.
          const output: ToolOutput = {
            kind: outputKindFor(existing.tool),
            text,
            isError: tr.is_error === true,
          };
          turns[idx] = { ...existing, output };
        }
        pendingToolIndex.delete(tr.tool_use_id);
        pendingToolInput.delete(tr.tool_use_id);
      }
      // unknown block types: ignored at the trust boundary.
    }
  }

  flushUsage();
  return turns;
}

// [LAW:dataflow-not-control-flow] Two-pass: parse lines → emit Turns. Tool-
// call pairing rewrites the Turn in place (the array is mutable internally;
// the readonly Turn type applies to consumers, not the builder).
export const parseClaudeJsonl = (input: string): Turn[] | null => {
  const lines = input.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  // Parse pass — if the first non-blank line doesn't deserialize as JSON,
  // this is not JSONL at all and we bail. Subsequent malformed lines are
  // skipped (real transcripts sometimes have partial writes at the tail).
  const events: unknown[] = [];
  let parsedAny = false;
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
      parsedAny = true;
    } catch {
      if (!parsedAny) return null; // first line failed → not JSONL
      // mid-file parse error — skip the line
    }
  }
  if (!parsedAny) return null;

  // Need at least one message event; non-message events alone (permission-
  // mode, bridge-session, etc.) don't constitute a parseable transcript.
  const messageEvents = events.filter(isMessageEvent);
  if (messageEvents.length === 0) return null;

  // [LAW:decomposition] Partition lines into the main transcript and each
  // subagent group by the top-level `agentId` (main lines carry none). Grouping
  // is by id, so the concatenation ORDER of the bundled files is irrelevant —
  // reattachment never depends on position. The main group is the one we build
  // from; subagent groups are pulled in by recursion when their Agent call is
  // reattached. A blob that is all sidechain (no main) is not a transcript.
  const MAIN = " main";
  const groups = new Map<string, MessageEvent[]>();
  for (const ev of messageEvents) {
    const key = typeof ev.agentId === "string" ? ev.agentId : MAIN;
    let group = groups.get(key);
    if (!group) { group = []; groups.set(key, group); }
    group.push(ev);
  }
  const mainEvents = groups.get(MAIN);
  if (!mainEvents || mainEvents.length === 0) return null;

  const turns = buildTurns(mainEvents, groups, new Set());

  // [LAW:no-silent-failure] Not every subagent is spawned by an Agent tool-call:
  // slash-command / skill background runs leave a subagent group with NO
  // toolUseResult.agentId pointing at it anywhere. Those groups must SURFACE, not
  // vanish. [LAW:one-source-of-truth] `referenced` is derived once from every
  // toolUseResult.agentId link across all groups; a group whose id is referenced
  // nowhere is a true orphan. This cannot double-surface a nested child (a child
  // is referenced by its parent's link, so it is never an orphan), so orphans are
  // appended exactly once, as top-level subagent turns, in first-seen order.
  const referenced = new Set<string>();
  for (const evs of groups.values()) {
    for (const ev of evs) {
      if (!isRecord(ev.toolUseResult)) continue;
      const a = strOrNull(ev.toolUseResult.agentId);
      if (a !== null) referenced.add(a);
    }
  }
  for (const [key, evs] of groups) {
    if (key === MAIN || referenced.has(key)) continue;
    const orphan = buildTurns(evs, groups, new Set([key]));
    if (!isNonEmptyTurns(orphan)) continue;
    // No spawning tool-call, so type/description come from the meta the uploader
    // folded onto the group's lines (null when the upload predates the fold).
    const { agentType, description } = orphanIdentity(evs);
    turns.push({
      kind: "subagent",
      agentType,
      description,
      stepCount: 0,
      transcript: { kind: "captured", turns: orphan },
    });
  }

  return turns.length >= 1 ? turns : null;
};

// [LAW:types-are-the-program] The two honest outcomes of trying to graft supplied
// subagent transcript lines onto a stored claude-jsonl blob. `ok` carries the new
// blob to store PLUS an honest accounting of which agent groups were appended vs
// already present; the failure arm carries one human-readable reason. A "partly
// applied" state is unrepresentable — augment is all-or-nothing.
export type AugmentResult =
  | {
      readonly ok: true;
      readonly content: string;
      readonly addedAgentIds: ReadonlyArray<string>;
      readonly skippedAgentIds: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: string };

// The three top-level fields the subagent join reads, lifted from an untrusted
// parsed line. [LAW:single-enforcer] They live here, the one owner of the JSONL
// schema — the augment endpoint never names a field of the wire format.
const lineSessionId = (v: unknown): string | null =>
  isRecord(v) ? strOrNull(v.sessionId) : null;
const lineAgentId = (v: unknown): string | null =>
  isRecord(v) ? strOrNull(v.agentId) : null;
const lineIsSidechain = (v: unknown): boolean =>
  isRecord(v) && v.isSidechain === true;

// [LAW:single-enforcer] Backfill capture: append supplied subagent transcript
// lines to a stored claude-jsonl origin so the re-derive resolves its degraded
// (summary-only) subagents to captured. This is additive capture of MORE of the
// original — consistent with store-the-original — never a rewrite. All JSONL
// schema knowledge (which session a line belongs to, which agent group it is)
// lives here; the endpoint hands raw text in and gets a validated blob out.
//
// [LAW:no-silent-failure] Validation is total and all-or-nothing: every supplied
// line must parse as JSON, carry a sessionId that matches the stored paste's
// session, and be a subagent sidechain line (agentId + isSidechain:true). A
// single foreign or unlinkable line fails the WHOLE request loudly — we never
// silently drop the bad lines and append the rest, which would graft a half-
// transcript under a paste it doesn't belong to.
//
// [LAW:one-source-of-truth] Reattachment is by agentId (the parser groups by it),
// so an agent group already present in the stored blob is SKIPPED, not re-
// appended — the capture recipe ships every subagent file including already-
// captured ones, and re-appending a present group would duplicate its lines and
// double its re-derived transcript. Dedup is id-based, never positional.
export const augmentJsonlWithSubagents = (
  existing: string,
  supplied: string,
): AugmentResult => {
  // The stored blob defines what "belongs to this paste": the set of session ids
  // it carries, and the agent groups already captured in it.
  const sessions = new Set<string>();
  const presentAgentIds = new Set<string>();
  for (const raw of existing.split("\n")) {
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const sid = lineSessionId(parsed);
    if (sid !== null) sessions.add(sid);
    const aid = lineAgentId(parsed);
    if (aid !== null) presentAgentIds.add(aid);
  }
  if (sessions.size === 0) {
    return {
      ok: false,
      reason: "The stored paste carries no session id, so subagent membership cannot be verified.",
    };
  }

  const suppliedLines = supplied.split("\n").filter((l) => l.trim().length > 0);
  if (suppliedLines.length === 0) {
    return { ok: false, reason: "No subagent transcript lines were supplied." };
  }

  // [LAW:no-silent-failure] Validate EVERY line before appending anything. Errors
  // accumulate so the response names every problem at once, not just the first.
  const errors: string[] = [];
  const accepted: Array<{ readonly line: string; readonly agentId: string }> = [];
  for (let i = 0; i < suppliedLines.length; i++) {
    const raw = suppliedLines[i]!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push(`line ${i + 1}: not valid JSON`);
      continue;
    }
    const sid = lineSessionId(parsed);
    if (sid === null || !sessions.has(sid)) {
      errors.push(
        `line ${i + 1}: belongs to a different session (${sid ?? "no sessionId"}) — this paste is session ${[...sessions].join(", ")}`,
      );
      continue;
    }
    const aid = lineAgentId(parsed);
    if (aid === null || !lineIsSidechain(parsed)) {
      errors.push(`line ${i + 1}: not a subagent sidechain line (needs agentId + isSidechain:true)`);
      continue;
    }
    accepted.push({ line: raw, agentId: aid });
  }
  if (errors.length > 0) {
    const shown = errors.slice(0, 10);
    const more = errors.length > shown.length ? ` (+${errors.length - shown.length} more)` : "";
    return { ok: false, reason: `Supplied transcript has unlinkable lines: ${shown.join("; ")}${more}` };
  }

  // [LAW:one-source-of-truth] Append only the agent groups not already captured.
  const addLines: string[] = [];
  const addedAgentIds = new Set<string>();
  const skippedAgentIds = new Set<string>();
  for (const { line, agentId } of accepted) {
    if (presentAgentIds.has(agentId)) {
      skippedAgentIds.add(agentId);
      continue;
    }
    addLines.push(line);
    addedAgentIds.add(agentId);
  }

  // Concatenation mirrors the uploader: one newline between the stored blob and
  // each appended line. Nothing new to add (every group already present) is an
  // idempotent success that re-stores byte-identical content.
  const content =
    addLines.length === 0
      ? existing
      : (existing.endsWith("\n") ? existing : existing + "\n") + addLines.join("\n");

  return {
    ok: true,
    content,
    addedAgentIds: [...addedAgentIds],
    skippedAgentIds: [...skippedAgentIds],
  };
};

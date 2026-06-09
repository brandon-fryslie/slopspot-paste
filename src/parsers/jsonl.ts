import type { Turn, ToolOutput, ToolOutputKind, Usage } from "../types";

// [LAW:types-are-the-program] Input is a Claude Code session JSONL — one
// typed event per line. Output is the same Turn[] union every other parser
// produces. Because the JSONL is *already structured*, this is the cleanest
// parser of the lot: walk discriminators, emit Turns, pair tool_use/result
// by id. No regex matching, no marker hunting, no inference.
//
// [LAW:single-enforcer] The JSONL schema lives in exactly one place — this
// file. The skill that uploads the JSONL knows zero about its shape; if
// Claude Code changes the schema, only this parser changes.

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
}
type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { readonly type: string };

interface MessageEvent {
  readonly type: "user" | "assistant";
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

const argsAsText = (input: unknown): string => {
  if (typeof input === "string") return input;
  if (input == null) return "";
  try { return JSON.stringify(input, null, 2); } catch { return String(input); }
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

  const turns: Turn[] = [];
  const pendingToolIndex = new Map<string, number>();

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
  for (const ev of messageEvents) {
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

  for (const ev of messageEvents) {
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
      } else if (block.type === "tool_result") {
        const tr = block as ToolResultBlock;
        if (typeof tr.tool_use_id !== "string") continue;
        const idx = pendingToolIndex.get(tr.tool_use_id);
        if (idx === undefined) continue;
        const existing = turns[idx];
        if (!existing || existing.kind !== "tool-call") continue;
        const text = resultText(tr.content);
        const output: ToolOutput = { kind: outputKindFor(existing.tool), text };
        turns[idx] = { ...existing, output };
        pendingToolIndex.delete(tr.tool_use_id);
      }
      // unknown block types: ignored at the trust boundary.
    }
  }

  flushUsage();

  return turns.length >= 1 ? turns : null;
};

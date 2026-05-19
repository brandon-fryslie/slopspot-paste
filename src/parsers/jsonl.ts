import type { Turn, ToolOutput, ToolOutputKind } from "../types";

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
interface ThinkingBlock { readonly type: "thinking" }
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
    readonly role?: string;
    readonly content?: string | ReadonlyArray<ContentBlock>;
  };
}

const isMessageEvent = (e: unknown): e is MessageEvent => {
  if (!e || typeof e !== "object") return false;
  const t = (e as { type?: unknown }).type;
  return t === "user" || t === "assistant";
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

  for (const ev of messageEvents) {
    const msg = ev.message;
    if (!msg) continue;
    const role = ev.type === "user" ? "user" : "assistant";
    const content = msg.content;

    if (typeof content === "string") {
      const cleaned = role === "user" ? stripEnvelope(content) : content.trim();
      if (cleaned.length === 0) continue;
      turns.push({ kind: "message", role, content: cleaned });
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "text") {
        const text = (block as TextBlock).text;
        if (typeof text !== "string") continue;
        const cleaned = role === "user" ? stripEnvelope(text) : text.trim();
        if (cleaned.length === 0) continue;
        turns.push({ kind: "message", role, content: cleaned });
      } else if (block.type === "tool_use") {
        const tu = block as ToolUseBlock;
        if (typeof tu.name !== "string") continue;
        turns.push({
          kind: "tool-call",
          tool: tu.name,
          args: argsAsText(tu.input),
          output: null,
        });
        pendingToolIndex.set(tu.id, turns.length - 1);
      } else if (block.type === "tool_result") {
        const tr = block as ToolResultBlock;
        const idx = pendingToolIndex.get(tr.tool_use_id);
        if (idx === undefined) continue;
        const existing = turns[idx];
        if (!existing || existing.kind !== "tool-call") continue;
        const text = resultText(tr.content);
        const output: ToolOutput = { kind: outputKindFor(existing.tool), text };
        turns[idx] = { ...existing, output };
        pendingToolIndex.delete(tr.tool_use_id);
      }
      // thinking blocks: deliberately skipped — private model reasoning.
      // unknown block types: ignored at the trust boundary.
    }
  }

  return turns.length >= 1 ? turns : null;
};

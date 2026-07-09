// [LAW:decomposition] The continuation bundle: turn a static paste into a launch point by
// giving the reader the conversation as text they can paste into a fresh LLM chat and
// continue from. A pure builder (ViewableDialogue -> one clipboard payload) beside the
// document-scoped control markup that carries it — the same split codeExport.ts uses for
// code artifacts, so a later affordance (a per-provider deep-link, slopspot-resume-239.4)
// is added as a SIBLING button on this control, never by re-shaping the builder.
//
// [LAW:one-way-deps] continuation depends on transcript (the one dialogue->text
// projection), dialogue (the ViewableDialogue type), and render (HTML escaping); none
// depends back on it.
//
// [LAW:effects-at-boundaries] Both exports are pure string builders. The clipboard write
// and the "Copied" reveal are the page's client concern, exactly as for the code control.

import type { ViewableDialogue } from "./dialogue";
import { renderDialogueTranscript } from "./transcript";
import { escapeHtml } from "./render";

// [LAW:one-source-of-truth] The one instruction that frames every continuation bundle. It
// leads the payload so the model reads its task before the transcript, then continues the
// next assistant turn naturally.
const CONTINUE_INSTRUCTION =
  "Continue the following conversation from where it left off, responding as the assistant.";

// [LAW:no-silent-failure] Redaction-safe by input TYPE: the builder takes the VIEWABLE
// dialogue — deriveViewableDialogue's overlay-applied projection, the single place a paste
// becomes viewable — so a hidden/redacted turn already carries "[redacted]" in place and
// its original content can never reach the copied text. It is never built from the raw
// origin, which still holds what the author hid.
//
// [LAW:dataflow-not-control-flow] The bundle is the framing instruction followed by the
// full (untruncated) transcript — a clipboard payload has no length ceiling, unlike a URL,
// so the whole conversation is kept, tail and all: the tail is precisely where the reader
// resumes. An empty transcript (a paste with no spine-visible prose) yields "" — the
// absence is a value the control renderer draws as nothing, never a dead button.
export const buildContinuationPayload = (view: ViewableDialogue): string => {
  const transcript = renderDialogueTranscript(view.map((d) => d.node));
  return transcript.length === 0 ? "" : `${CONTINUE_INSTRUCTION}\n\n${transcript}`;
};

// [LAW:dataflow-not-control-flow] The document-scoped continuation control, or NOTHING when
// there is no readable conversation to continue (empty payload). It mirrors the code-export
// control's shape — a pill button beside a hidden sibling <pre> holding the server-built
// payload the button reads — so the clipboard bytes equal the server projection
// [LAW:one-source-of-truth] and the button stays hidden until the client's own capability
// check reveals it, so a no-JS viewer never meets a button that cannot act
// [LAW:no-silent-failure].
export const renderContinuationControl = (view: ViewableDialogue): string => {
  const payload = buildContinuationPayload(view);
  if (payload.length === 0) return "";
  const label = "Copy to continue elsewhere";
  return (
    `<button type="button" class="mono-pill continuation-pill copy-continuation" data-copy-continuation>${escapeHtml(label)}</button>` +
    `<pre class="copy-continuation-payload" hidden aria-hidden="true">${escapeHtml(payload)}</pre>`
  );
};

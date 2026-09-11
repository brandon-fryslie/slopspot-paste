// The two pure readings the generation loop makes of the device (slopspot-read-along-q35.v70),
// checked on jax-js's Wasm device in Node: `promptFrames` reads how many cache positions a
// voice prompt occupies, which anchors the read-out window's `textStart`; `readStep` splits
// one readback row into the EOS bit and one attention logit per text token. Each is proven
// on a known array and shown to throw on the wrong shape rather than read past it
// [LAW:verifiable-goals] [LAW:no-silent-failure]. Run: `tsx scripts/runtime-step-check.ts`.

import { defaultDevice, init, numpy as np } from "@jax-js/jax";
import { promptFrames, readStep } from "../src/pocketTtsRuntime";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};
const throws = (label: string, fn: () => unknown): void => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(label, threw);
};
const rejects = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assert(label, threw);
};

const devices = await init("cpu", "wasm");
assert("jax-js offers a Wasm device in Node", devices.includes("wasm"));
defaultDevice("wasm");

console.log("prompt frames");
{
  assert("a [frames, dim] prompt occupies `frames` cache positions", promptFrames("alba", np.zeros([7, 4], { dtype: np.float32 })) === 7);
  throws("a rank-1 prompt is thrown", () => promptFrames("alba", np.zeros([7], { dtype: np.float32 })));
  throws("a rank-3 prompt is thrown", () => promptFrames("alba", np.zeros([7, 4, 1], { dtype: np.float32 })));
}

console.log("step reading");
{
  const logits = np.array(new Float32Array([0.5, -1.25, 3]), { shape: [3], dtype: np.float32 });
  const said = await readStep(np.array(new Float32Array([1]), { shape: [1], dtype: np.float32 }), logits.ref, 3);
  assert("an EOS bit of one reads as EOS", said.eos);
  assert("the logits follow the bit, one per token", said.logits.length === 3 && said.logits[0] === 0.5 && said.logits[1] === -1.25 && said.logits[2] === 3);
  const unsaid = await readStep(np.array(new Float32Array([0]), { shape: [1], dtype: np.float32 }), logits.ref, 3);
  assert("an EOS bit of zero reads as not EOS, with the same logits", !unsaid.eos && unsaid.logits[2] === 3);
  await rejects("a row with fewer logits than tokens is thrown", () => readStep(np.array(new Float32Array([0]), { shape: [1], dtype: np.float32 }), logits.ref, 4));
  await rejects("a row with more logits than tokens is thrown", () => readStep(np.array(new Float32Array([0]), { shape: [1], dtype: np.float32 }), logits, 2));
}

if (process.exitCode === 1) {
  console.error("\nSome runtime step checks failed.");
} else {
  console.log("\nAll runtime step checks passed.");
}

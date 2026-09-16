// Pre-synthesis allowance: the rule over what the device reports, and the watcher over a stub
// browser whose battery and connection change by hand (slopspot-read-along-a35.6.rub).
// Run: `tsx scripts/presynthesis-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about whether making ahead is allowed and
// when a listener is told — never about how a reading is held.
//
// ─── ACCEPT TABLE ────────────────────────────────────────────────────────────────
//   charging, known                        -> allowed
//   unmetered, known                       -> allowed
//   neither known yes                      -> not allowed, unknowns included
//   wifi | ethernet                        -> unmetered; cellular | bluetooth | wimax -> metered
//   save data                              -> metered, whatever the link
//   no API, unknown, none, other, mixed    -> unknown
//   no battery API and no connection API   -> never allowed
//   the battery answers charging           -> allowed from then; listeners told once
//   charging stops, the link changes       -> each change of the answer told once; no change, no word
//   the battery API refuses                -> unknown, not allowed
//   unsubscribe                            -> told nothing more

import type { ConnectionReading } from "../src/modelAssets";
import { allows, meteringOf, watchAllowance, type BatteryReading, type DeviceSource, type Reading } from "../src/presynthesis";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const UNKNOWN: Reading<boolean> = { kind: "unknown" };
const yes: Reading<boolean> = { kind: "known", value: true };
const no: Reading<boolean> = { kind: "known", value: false };

console.log("the rule");
assert("charging allows", allows({ charging: yes, unmetered: UNKNOWN }));
assert("an unmetered connection allows", allows({ charging: no, unmetered: yes }));
assert("not charging on a metered link does not", !allows({ charging: no, unmetered: no }));
assert("what the browser cannot say is not a yes", !allows({ charging: UNKNOWN, unmetered: UNKNOWN }));

console.log("metering");
const metered = (connection: ConnectionReading | undefined): string => {
  const reading = meteringOf(connection);
  return reading.kind === "unknown" ? "unknown" : reading.value ? "unmetered" : "metered";
};
assert("wifi and ethernet are unmetered", metered({ type: "wifi" }) === "unmetered" && metered({ type: "ethernet" }) === "unmetered");
assert("cellular, bluetooth and wimax are metered", ["cellular", "bluetooth", "wimax"].every((type) => metered({ type }) === "metered"));
assert("a request to save data is metered, even on wifi", metered({ type: "wifi", saveData: true }) === "metered");
assert("no API, or a type that names no medium, is unknown", [undefined, {}, { type: "unknown" }, { type: "none" }, { type: "other" }, { type: "mixed" }].every((connection) => metered(connection) === "unknown"));

// A browser whose battery and connection are changed by hand.
const stubBrowser = ({ charging, type, battery = "answers" }: { charging?: boolean; type?: string; battery?: "answers" | "refuses" | "absent" }) => {
  const power = Object.assign(new EventTarget(), { charging: charging ?? false }) as EventTarget & { charging: boolean };
  const connection = type === undefined ? undefined : (Object.assign(new EventTarget(), { type }) as EventTarget & { type: string });
  const source: DeviceSource = {
    ...(battery === "absent" ? {} : { getBattery: () => (battery === "answers" ? Promise.resolve(power as BatteryReading) : Promise.reject(new Error("not allowed"))) }),
    ...(connection === undefined ? {} : { connection }),
  };
  return {
    source,
    charge: (to: boolean) => {
      power.charging = to;
      power.dispatchEvent(new Event("chargingchange"));
    },
    link: (to: string) => {
      if (connection === undefined) throw new Error("fixture: no connection");
      connection.type = to;
      connection.dispatchEvent(new Event("change"));
    },
  };
};

console.log("watching the device");
{
  const nothing = watchAllowance({});
  await flush();
  assert("a browser that says nothing never allows", !nothing.allowed());
}
{
  const browser = stubBrowser({ charging: true });
  const allowance = watchAllowance(browser.source);
  let told = 0;
  const unsubscribe = allowance.subscribe(() => (told += 1));
  assert("before the battery answers: unknown, not allowed", !allowance.allowed());
  await flush();
  assert("the battery answers charging: allowed, told once", allowance.allowed() && told === 1);
  browser.charge(true);
  assert("the same answer again: no word", told === 1);
  browser.charge(false);
  assert("unplugged: not allowed, told", !allowance.allowed() && told === 2);
  unsubscribe();
  browser.charge(true);
  assert("unsubscribed: told nothing more", allowance.allowed() && told === 2);
}
{
  const browser = stubBrowser({ charging: false, type: "cellular" });
  const allowance = watchAllowance(browser.source);
  let told = 0;
  allowance.subscribe(() => (told += 1));
  await flush();
  assert("on battery over cellular: not allowed", !allowance.allowed() && told === 0);
  browser.link("wifi");
  assert("onto wifi: allowed, told", allowance.allowed() && told === 1);
  browser.charge(true);
  assert("charging too: still allowed, no word", allowance.allowed() && told === 1);
}
{
  const browser = stubBrowser({ type: "wifi", battery: "refuses" });
  const allowance = watchAllowance(browser.source);
  await flush();
  assert("a battery API that refuses leaves the connection to say: wifi allows", allowance.allowed());
  browser.link("unknown");
  assert("and a link that says nothing does not", !allowance.allowed());
}

// [LAW:decomposition] Pre-synthesis allowance: whether this device, right now, lets a listen
// make audio nobody has asked for yet. One sentence, no "and": this module reads the
// device's power and connection and says yes or no as they change. It makes nothing
// (keptSynthesis.ts spends the allowance on the worker's idle time) and decides no order
// (scheduler.ts). The reading of the browser is a parameter, so
// scripts/presynthesis-check.ts drives every arm with a stub [LAW:effects-at-boundaries].
//
// THE RULE. Making a paste ahead runs the GPU for as long as the paste is long, so it runs
// only where that costs the reader nothing they would notice: the device is charging, or
// its connection is known to be unmetered (wifi or ethernet, with no request to save data).
// What the browser cannot say is not a yes [LAW:types-are-the-program]: a reading is known
// or unknown, and only a known yes allows. Safari offers neither API, and desktop Chromium
// offers the battery alone — which reads as charging on a machine without one.
//
// [LAW:no-silent-failure] exception: a battery reading the browser refuses (a permissions
// policy, an insecure context) is the browser not saying, which is `unknown` — the rule
// already treats it as no, so there is nothing further to report.

import type { ConnectionReading } from "./modelAssets";

export type Reading<T> = { readonly kind: "unknown" } | { readonly kind: "known"; readonly value: T };

const UNKNOWN = { kind: "unknown" } as const;
const known = <T>(value: T): Reading<T> => ({ kind: "known", value });

export interface DeviceConditions {
  readonly charging: Reading<boolean>;
  readonly unmetered: Reading<boolean>;
}

// [LAW:single-enforcer] The rule, once.
export const allows = ({ charging, unmetered }: DeviceConditions): boolean =>
  (charging.kind === "known" && charging.value) || (unmetered.kind === "known" && unmetered.value);

// What the Network Information API says of metering. A request to save data is a known no
// whatever the link; a link type that names its medium is known; anything else — no API,
// `unknown`, `none`, `other`, `mixed` — is not a reading at all.
export const meteringOf = (connection: ConnectionReading | undefined): Reading<boolean> => {
  if (connection === undefined) return UNKNOWN;
  if (connection.saveData === true) return known(false);
  switch (connection.type) {
    case "wifi":
    case "ethernet":
      return known(true);
    case "cellular":
    case "bluetooth":
    case "wimax":
      return known(false);
    default:
      return UNKNOWN;
  }
};

// The browser's side, as much of it as is read: the battery's charging flag and the
// connection, each an event target that says when it changed.
export interface BatteryReading extends EventTarget {
  readonly charging: boolean;
}
export interface DeviceSource {
  readonly getBattery?: () => Promise<BatteryReading>;
  readonly connection?: ConnectionReading & EventTarget;
}

export interface Allowance {
  readonly allowed: () => boolean;
  // Called whenever `allowed` changes; returns the unsubscribe.
  readonly subscribe: (listener: () => void) => () => void;
}

export const watchAllowance = (source: DeviceSource): Allowance => {
  // [LAW:no-shared-mutable-globals] The last reading and who is told of a change, owned here.
  let conditions: DeviceConditions = { charging: UNKNOWN, unmetered: meteringOf(source.connection) };
  const listeners = new Set<() => void>();
  const read = (next: Partial<DeviceConditions>): void => {
    const before = allows(conditions);
    conditions = { ...conditions, ...next };
    if (allows(conditions) !== before) for (const listener of [...listeners]) listener();
  };
  source.connection?.addEventListener("change", () => read({ unmetered: meteringOf(source.connection) }));
  source.getBattery?.().then(
    (battery) => {
      read({ charging: known(battery.charging) });
      battery.addEventListener("chargingchange", () => read({ charging: known(battery.charging) }));
    },
    () => undefined,
  );
  return {
    allowed: () => allows(conditions),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

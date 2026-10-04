/**
 * What another process may use from here. The ledger imports this to run the
 * notifier in its own process; `index.ts` is the notifier as a process of its
 * own.
 */
export * from "./notify.js";

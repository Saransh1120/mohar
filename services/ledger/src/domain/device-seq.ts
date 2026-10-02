export type SequenceObservation =
  | { kind: "next" }
  | { kind: "missing" }
  | { kind: "gap"; lastSeenSeq: number; receivedSeq: number; missingCount: number }
  | { kind: "regression"; lastSeenSeq: number; receivedSeq: number };

/** A missing sequence number is evidence at receipt time, even if it arrives later. */
export function observeDeviceSequence(
  lastSeenSeq: number,
  receivedSeq: number | undefined,
): SequenceObservation {
  if (receivedSeq === undefined) return { kind: "missing" };
  if (receivedSeq <= lastSeenSeq) return { kind: "regression", lastSeenSeq, receivedSeq };
  if (receivedSeq > lastSeenSeq + 1) {
    return {
      kind: "gap",
      lastSeenSeq,
      receivedSeq,
      missingCount: receivedSeq - lastSeenSeq - 1,
    };
  }
  return { kind: "next" };
}

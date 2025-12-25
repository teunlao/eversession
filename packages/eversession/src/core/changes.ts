export type Change =
  | { kind: "delete_line"; line: number; reason: string }
  | { kind: "update_line"; line: number; reason: string }
  | { kind: "insert_after"; afterLine: number; reason: string };

export type ChangeSet = {
  changes: Change[];
};

export function isNoop(changeSet: ChangeSet): boolean {
  return changeSet.changes.length === 0;
}

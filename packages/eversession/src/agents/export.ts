export type ExportMessage = { kind: "message"; role: string; text: string; line: number };
export type ExportCompacted = { kind: "compacted"; text: string; line: number };
export type ExportTool = { kind: "tool"; name: string; text: string; line: number };
export type ExportReasoning = { kind: "reasoning"; text: string; line: number };

export type ExportItem = ExportMessage | ExportCompacted | ExportTool | ExportReasoning;

export type ExportParams = { full?: boolean };

export type ExportResult = { items: ExportItem[]; format: string };

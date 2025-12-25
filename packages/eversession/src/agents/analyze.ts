export type AnalyzeDetail = {
  format: string;
  analysis: unknown;
  summary: string[];
  extras?: Record<string, unknown>;
};

export type AnalyzeParams = Record<string, never>;

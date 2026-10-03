export type Source = { id: string; name: string; kind: 'md' | 'hwpx'; content: string };
export type Target = { sourceId: string; line: number; start: number; end: number; anchor?: any };
export type Field = {
  id: string; name: string; column: string; kind: 'field' | 'block' | 'fixed'; approved: boolean;
  format: 'text' | 'money'; values: string[]; targets: Target[]; evidence: string; confidence: number;
};
export type Block = {
  id: string; group: string; alias: string; engine_type: 'markdown' | 'hwpx_fragment';
  condition: string; priority: number; content: string; sourceId?: string; from?: number; to?: number;
};
export type Range = { id: string; group: string; sourceId: string; from: number; to: number };
export type Project = {
  version: 1; name: string; mode: 'markdown' | 'hwpx'; markdown: string; sources: Source[];
  fields: Field[]; blocks: Block[]; ranges: Range[]; records: Record<string, unknown>[];
  activeRecord?: number; selectedBlocks?: Record<string,string>;
};

export interface StagedRow {
  id: string; accountKey: string; symbol: string; description: string; subType: string;
  quantity: string | null; filePrice: string | null; fileValue: string | null; costBasis: string | null;
  sourceAssetType: string; isCash: boolean; included: boolean; warnings: string[]; rowIndex: number;
}
export interface StagedAccount { key: string; name: string; mask: string | null }
export interface ParsedFile {
  format: 'single-account-positions' | 'multi-account-positions' | 'generic-mapped';
  asOf: string; accounts: StagedAccount[]; rows: StagedRow[];
  statedTotals: { accountKey: string; value: string }[]; warnings: string[];
}
export class UnrecognizedFormatError extends Error {}

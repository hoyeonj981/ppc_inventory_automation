export interface InventoryRecord {
  barcode: string;
  quantity: number;
  expirationDate: string;
  location: string;
  foundBy: string;
  foundAt: string;
  type: "overstock" | "shortage";
  source?: "app" | "message";
  skuName?: string;
  photoFileId?: string;
}

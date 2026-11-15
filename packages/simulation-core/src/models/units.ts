export interface MoneyUnit {
  readonly kind: 'money';
  readonly currencyId: string;
  readonly unit: string;
  readonly scale: number;
  readonly minor: number;
}

export interface CommodityQuantity {
  readonly kind: 'commodity';
  readonly commodityId: string;
  readonly unit: string;
  readonly scale: number;
  readonly quantity: number;
}

export interface UnitDefinition {
  readonly id: string;
  readonly unit: string;
  readonly scale: number;
}

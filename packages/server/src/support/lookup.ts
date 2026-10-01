import type { Catalog, Product } from '../products/catalog.js';
import { assessWarranty, type WarrantyAssessment } from './warranty.js';

export interface WarrantyLookup {
  product: Product;
  /** Where the purchase date came from. A registered purchase wins over one the user states. */
  source: 'registered' | 'user_provided' | 'unknown';
  purchaseDate?: string;
  assessment: WarrantyAssessment;
}

/** Finds the purchase date for a product (the user's registered one, else one they told us) and rates the warranty. */
export function lookupWarranty(
  deps: { catalog: Catalog; now: () => Date },
  userId: string | undefined,
  productId: string,
  providedPurchaseDate?: string,
): WarrantyLookup | undefined {
  const product = deps.catalog.getProduct(productId);
  if (!product) return undefined;

  const registered = userId ? deps.catalog.ownedBy(userId).find((owned) => owned.productId === productId) : undefined;
  const purchaseDate = registered?.purchaseDate ?? providedPurchaseDate;
  const source = registered ? 'registered' : providedPurchaseDate ? 'user_provided' : 'unknown';
  return { product, source, purchaseDate, assessment: assessWarranty(purchaseDate, product.warrantyTermMonths, deps.now()) };
}

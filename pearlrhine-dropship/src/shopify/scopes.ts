/** Muss mit [access_scopes] in shopify.app.toml übereinstimmen. */
export const ADMIN_SCOPES = [
  'read_products',
  'read_inventory',
  'read_locations',
  'read_orders',
  'write_orders',
  'write_draft_orders',
  'read_draft_orders',
  'read_companies',
  'read_fulfillments',
  'read_payment_terms',
  'write_payment_terms',
].join(',');

const validSellablePrice = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

// Stock is now authoritative. This remains availability only: Inventory V1
// deliberately does not reserve units before a trusted payment confirmation.
const resolvePublicCapabilities = (product) => ({
  isPurchasable: Boolean(product?.is_purchasable) && validSellablePrice(product?.price) && Number(product?.stock_qty) > 0,
  isEnquiryEnabled: Boolean(product?.is_enquiry_enabled),
});

module.exports = { resolvePublicCapabilities, validSellablePrice };

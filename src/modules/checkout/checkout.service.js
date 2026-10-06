const cartService = require('../cart/cart.service');
const addressService = require('../addresses/address.service');
const orderService = require('../orders/order.service');
const { ValidationError } = require('../../utils/errors');
const { requirePricedShipping } = require('./shipping.service');

const GST_RATE_PERCENT = 3;
const GST_RATE_BASIS_POINTS = 300;

const decimalToPaise = (value, field = 'amount') => {
  const text = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new ValidationError(`Validated ${field} is invalid`);

  const whole = BigInt(match[1]);
  const fraction = (match[2] || '').padEnd(3, '0');
  let paise = whole * 100n + BigInt(fraction.slice(0, 2));
  // Monetary values are rounded to the nearest paise, half up, before taxes.
  if (fraction[2] >= '5') paise += 1n;
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new ValidationError(`Validated ${field} is too large`);
  return paise;
};

const paiseToDecimal = (paise) => {
  const whole = paise / 100n;
  const fraction = String(paise % 100n).padStart(2, '0');
  return `${whole}.${fraction}`;
};

const paiseToNumber = (paise) => Number(paise) / 100;

// GST is always calculated from the authoritative subtotal after each line is
// rounded to paise. Positive half-paise values round up.
const calculateGstPaise = (subtotalPaise) => (subtotalPaise * BigInt(GST_RATE_BASIS_POINTS) + 5000n) / 10000n;

const toOrderItem = (item) => {
  const unitPricePaise = decimalToPaise(item.unitPrice, 'item price');
  const quantity = BigInt(item.quantity);
  return {
    productId: item.productId,
    productName: item.product.name,
    productSku: item.product.sku || null,
    imageUrl: item.product.primaryImageUrl || null,
    quantity: item.quantity,
    unitPricePaise,
    lineSubtotalPaise: unitPricePaise * quantity,
  };
};

const presentItem = (item) => ({
  productId: item.productId,
  productName: item.productName,
  imageUrl: item.imageUrl,
  quantity: item.quantity,
  unitPrice: paiseToNumber(item.unitPricePaise),
  lineSubtotal: paiseToNumber(item.lineSubtotalPaise),
});

const prepare = async ({ tenantId, customerId, items, addressId, idempotencyKey, requestId = null }) => {
  const validation = await cartService.validateItems(tenantId, items);
  if (validation.invalidItems.length > 0 || validation.items.length !== items.length) {
    throw new ValidationError('Your bag has changed. Review the unavailable items before checkout.', validation.invalidItems);
  }

  const shippingAddressSnapshot = await addressService.getOwnedActiveSnapshot(tenantId, customerId, addressId);
  const trustedItems = validation.items.map(toOrderItem);
  const subtotalPaise = trustedItems.reduce((total, item) => total + item.lineSubtotalPaise, 0n);
  const gstPaise = calculateGstPaise(subtotalPaise);
  const shipping = await requirePricedShipping({ tenantId, subtotalPaise, shippingAddressSnapshot });
  const shippingPaise = shipping.amountPaise;
  const totalPaise = subtotalPaise + gstPaise + shippingPaise;

  const order = await orderService.createTrustedOrder({
    tenantId,
    customerId,
    idempotencyKey,
    requestId,
    items: trustedItems.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      productSku: item.productSku,
      imageUrl: item.imageUrl,
      quantity: item.quantity,
      unitPrice: paiseToDecimal(item.unitPricePaise),
      lineSubtotal: paiseToDecimal(item.lineSubtotalPaise),
    })),
    shippingAddressSnapshot,
    monetary: {
      subtotal: paiseToDecimal(subtotalPaise),
      discountAmount: '0.00',
      taxAmount: paiseToDecimal(gstPaise),
      shippingAmount: paiseToDecimal(shippingPaise),
      total: paiseToDecimal(totalPaise),
    },
  });

  return {
    orderReference: order.orderNumber,
    reused: order.reused,
    items: trustedItems.map(presentItem),
    deliveryAddress: shippingAddressSnapshot,
    subtotal: paiseToNumber(subtotalPaise),
    gstRatePercent: GST_RATE_PERCENT,
    gstAmount: paiseToNumber(gstPaise),
    shippingAmount: paiseToNumber(shippingPaise),
    shipping: { status: shipping.status, zoneName: shipping.zoneName },
    totalAmount: paiseToNumber(totalPaise),
    currency: 'INR',
    paymentStatus: 'PENDING',
    nextAction: 'PAYMENT_REQUIRED',
  };
};

module.exports = {
  GST_RATE_PERCENT,
  decimalToPaise,
  paiseToDecimal,
  calculateGstPaise,
  prepare,
};

const pool = require('../../config/db');
const { AppError } = require('../../utils/errors');
const { normalizeStateMatchKey, normalizeCountryMatchKey } = require('../shipping/stateMatcher');

const normalizeState = normalizeStateMatchKey;
const normalizeCountry = normalizeCountryMatchKey;

const calculateShipping = async ({ tenantId, subtotalPaise, shippingAddressSnapshot, database = pool }) => {
  const policyResult = await database.query(
    `SELECT free_shipping_enabled, free_shipping_threshold_paise, international_fallback_mode
     FROM SHIPPING_POLICIES WHERE tenant_id = $1`, [tenantId]
  );
  const policy = policyResult.rows[0];
  if (policy?.free_shipping_enabled && policy.free_shipping_threshold_paise !== null
    && BigInt(subtotalPaise) >= BigInt(policy.free_shipping_threshold_paise)) {
    return { status: 'FREE', amountPaise: 0n, zoneId: null, zoneName: 'Free shipping' };
  }

  const country = normalizeCountry(shippingAddressSnapshot.country);
  const state = normalizeState(shippingAddressSnapshot.state);
  const zones = await database.query(
    `SELECT id, name, country_code, state_name, fulfillment_mode, flat_rate_paise
     FROM SHIPPING_ZONES
     WHERE tenant_id = $1 AND is_enabled = true AND (country_code = $2 OR country_code = '*')
     ORDER BY CASE WHEN country_code = $2 THEN 0 ELSE 1 END,
              CASE WHEN state_name IS NOT NULL AND state_name = $3 THEN 0 ELSE 1 END,
              priority ASC, id ASC`,
    [tenantId, country, state]
  );
  // Country-specific zones always beat wildcard-country zones; within either
  // group a canonical state match beats a state-agnostic fallback. SQL keeps
  // priority/id order stable within each candidate group.
  const chooseZone = (candidates) => candidates.find((row) => row.state_name && normalizeState(row.state_name) === state)
    || candidates.find((row) => !row.state_name);
  const zone = chooseZone(zones.rows.filter((row) => row.country_code === country))
    || chooseZone(zones.rows.filter((row) => row.country_code === '*'));
  if (!zone || zone.fulfillment_mode === 'CONTACT_US') {
    // V1 deliberately supports exactly one no-rate outcome. Keeping the policy
    // value explicit makes the behaviour tenant-configurable without loading
    // arbitrary providers or silently falling back to a monetary value.
    const fallbackMode = zone?.fulfillment_mode || policy?.international_fallback_mode || 'CONTACT_US';
    return { status: fallbackMode, amountPaise: null, zoneId: zone?.id || null, zoneName: zone?.name || null };
  }
  return { status: 'FLAT', amountPaise: BigInt(zone.flat_rate_paise), zoneId: zone.id, zoneName: zone.name };
};

const requirePricedShipping = async (input) => {
  const shipping = await calculateShipping(input);
  if (shipping.status === 'CONTACT_US') {
    throw new AppError('Shipping for this destination requires assistance', 422, 'SHIPPING_CONTACT_US', { shipping });
  }
  return shipping;
};

module.exports = { calculateShipping, requirePricedShipping, normalizeState, normalizeCountry };

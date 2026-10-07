// This key is used only for server-side shipping-zone matching. It never
// rewrites an address's customer-visible state text or historical snapshots.
// Add aliases deliberately as supported zones require them; it is not a free
// text-to-geography service.
const STATE_MATCH_ALIASES = Object.freeze({
  TN: 'TAMIL NADU',
  TAMILNADU: 'TAMIL NADU',
});

// Addresses created before the country-code validation was introduced may use
// the human label "India".  Zone configuration remains ISO-code based, so
// canonicalise legacy address values at the shipping matcher boundary.
const COUNTRY_MATCH_ALIASES = Object.freeze({
  INDIA: 'IN',
});

const normalizeStateMatchKey = (value) => {
  const normalized = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!normalized) return '';

  const compact = normalized.replace(/[^A-Z0-9]/g, '');
  return STATE_MATCH_ALIASES[compact] || normalized;
};

const normalizeCountryMatchKey = (value) => {
  const normalized = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase();
  return COUNTRY_MATCH_ALIASES[normalized] || normalized;
};

module.exports = { STATE_MATCH_ALIASES, COUNTRY_MATCH_ALIASES, normalizeStateMatchKey, normalizeCountryMatchKey };

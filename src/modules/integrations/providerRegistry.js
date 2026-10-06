const GOOGLE_PROVIDER_CODE = 'GOOGLE';
const GOOGLE_PROVIDER_MODE = 'ONE_TAP';
const RAZORPAY_PROVIDER_CODE = 'RAZORPAY';
const RAZORPAY_PROVIDER_MODES = Object.freeze(['TEST', 'LIVE']);

// Providers are intentionally registered in code. Database configuration may
// choose whether a supported provider is active, but never what code executes.
const providerRegistry = Object.freeze({
  [GOOGLE_PROVIDER_CODE]: Object.freeze({
    code: GOOGLE_PROVIDER_CODE,
    supportedModes: Object.freeze([GOOGLE_PROVIDER_MODE]),
  }),
  [RAZORPAY_PROVIDER_CODE]: Object.freeze({
    code: RAZORPAY_PROVIDER_CODE,
    supportedModes: RAZORPAY_PROVIDER_MODES,
  }),
});

module.exports = {
  GOOGLE_PROVIDER_CODE,
  GOOGLE_PROVIDER_MODE,
  RAZORPAY_PROVIDER_CODE,
  RAZORPAY_PROVIDER_MODES,
  providerRegistry,
};

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  customerLoginSchema,
  googleSchema,
  registerSchema,
  updateCustomerProfileSchema,
} = require('../src/modules/auth/auth.validator');
const { createAddressSchema } = require('../src/modules/addresses/address.validator');

const validate = (schema, body) => schema.validate(
  { body, params: {}, query: {} },
  { abortEarly: false }
);

test('registration accepts a valid customer request', () => {
  const { error } = validate(registerSchema, {
    fullName: 'Ananya Natarajan',
    email: 'ananya@example.com',
    password: 'Sagunthala9',
    confirmPassword: 'Sagunthala9',
  });

  assert.equal(error, undefined);
});

test('registration rejects invalid email, weak password, and password mismatch', () => {
  const { error } = validate(registerSchema, {
    fullName: 'A',
    email: 'not-an-email',
    password: 'password',
    confirmPassword: 'different',
  });

  assert.ok(error);
  const messages = error.details.map((detail) => detail.message);
  assert.ok(messages.some((message) => message.includes('email')));
  assert.ok(messages.some((message) => message.includes('Password must include')));
  assert.ok(messages.some((message) => message.includes('Passwords do not match')));
});

test('customer login rejects malformed credentials before the service is called', () => {
  const { error } = validate(customerLoginSchema, {
    email: 'invalid-email',
    password: '',
  });

  assert.ok(error);
  assert.equal(error.details.length >= 2, true);
});

test('Google sign-in requires an ID token and accepts a bounded token payload', () => {
  assert.ok(validate(googleSchema, {}).error);
  assert.equal(validate(googleSchema, { idToken: 'google-id-token' }).error, undefined);
});

test('profile updates require a usable full name', () => {
  assert.ok(validate(updateCustomerProfileSchema, { fullName: ' ' }).error);
  assert.equal(validate(updateCustomerProfileSchema, { fullName: 'Ananya Natarajan' }).error, undefined);
});

test('address validation accepts practical Indian delivery details and rejects invalid PIN codes', () => {
  const valid = createAddressSchema.validate({
    body: { fullName: 'Ananya Natarajan', phone: '98765 43210', addressLine1: '12 Temple Road', city: 'Chennai', state: 'Tamil Nadu', pincode: '600001' },
    params: {}, query: {},
  });
  assert.equal(valid.error, undefined);
  const invalid = createAddressSchema.validate({
    body: { fullName: 'A', phone: 'invalid', addressLine1: '', city: '', state: '', pincode: '123' },
    params: {}, query: {},
  });
  assert.ok(invalid.error);
});

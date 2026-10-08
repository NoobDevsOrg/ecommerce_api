# API Reference

## Response Format

### Success

```json
{
  "success": true,
  "statusCode": 200,
  "message": "Short meaningful message",
  "data": {}
}
```

### Error

```json
{
  "success": false,
  "statusCode": 400,
  "message": "Clear user-friendly error message",
  "error": {
    "code": "VALIDATION_ERROR",
    "details": []
  }
}
```

## Auth Endpoints

### POST /auth/login
- Description: Authenticate an active staff/admin user and return an access/refresh token pair. Customers must use `/auth/customer/login`.
- Request body:
```json
{
  "email": "user@example.com",
  "password": "string (min 6)"
}
```
- Success status: 200
- Error status: 400, 401, 403, 500

### POST /auth/register
- Description: Create an email/password customer account for the resolved tenant and return the standard application session.
- Request body:
```json
{
  "fullName": "Customer name",
  "email": "customer@example.com",
  "password": "UppercaseLowercaseAndNumber1",
  "confirmPassword": "UppercaseLowercaseAndNumber1"
}
```
- Passwords must be 8–128 characters and contain uppercase, lowercase, and numeric characters.
- Success status: 201
- Error status: 400, 409, 429, 500

### POST /auth/customer/login
- Description: Authenticate an active customer only. Staff accounts are not accepted by this endpoint.
- Request body:
```json
{
  "email": "customer@example.com",
  "password": "string"
}
```
- Success status: 200
- Error status: 400, 401, 429, 500

### POST /auth/google
- Description: Verify a Google ID token on the server and create or authenticate a customer account for the resolved tenant.
- Request body:
```json
{
  "idToken": "google-id-token"
}
```
- The backend validates the token against the enabled tenant's configured Google OAuth web client ID and persists Google's stable `sub` value, never browser-supplied profile data, as the identity key.
- Existing password accounts are not silently linked by matching email; they must continue using their existing sign-in method until a separately designed account-linking flow exists.
- Success status: 200
- Error status: 400, 401, 409, 429, 503, 500

### POST /auth/refresh
- Description: Rotate refresh token and return a new token pair.
- Request body:
```json
{
  "refreshToken": "jwt"
}
```
- Success status: 200
- Error status: 400, 401, 500

### GET /auth/me
- Description: Return the authenticated user profile.
- Headers: Authorization: Bearer <accessToken>
- Success status: 200
- Error status: 401, 404, 500

### GET /auth/customer/me
- Description: Return the authenticated customer's safe profile projection.
- Headers: Authorization: Bearer <accessToken>
- Success status: 200
- Error status: 401, 403, 404, 500

### PATCH /auth/customer/profile
- Description: Update the authenticated customer's full name.
- Headers: Authorization: Bearer <accessToken>
- Request body:
```json
{
  "fullName": "Customer name"
}
```
- Success status: 200
- Error status: 400, 401, 403, 500

### POST /auth/logout
- Description: Invalidate current refresh token.
- Headers: Authorization: Bearer <accessToken>
- Request body:
```json
{
  "refreshToken": "jwt"
}
```
- Success status: 200
- Error status: 400, 401, 500

## Address endpoints

All address endpoints require a customer access token. The authenticated customer and resolved tenant determine ownership; `customer_id` is never accepted from the browser.

### GET /addresses
- Description: List up to 100 active saved addresses for the authenticated customer, with the default first.
- Success status: 200

## Product purchase capability

- Admin product create/update accepts `is_purchasable` and `is_enquiry_enabled` booleans. These are tenant-scoped product settings and require the existing `ADMIN` product authorization.
- Public product list/detail responses expose only `isPurchasable` and `isEnquiryEnabled`. `isPurchasable` is true only when the stored purchase switch is enabled **and** the product has a positive sellable price.
- `stock_qty` remains an inventory signal, separate from commercial purchase eligibility. Stock reservation, deduction, checkout totals, and payment are not part of this capability.
- Apply `migrations/20260922_add_product_purchase_capabilities.sql` before deploying this feature. It is additive; rollback requires code that no longer reads the fields, then dropping the columns through the approved process.

### POST /addresses
- Description: Add an address. The first active address becomes the default. A rapid retry with identical normalized address data returns the existing address instead of creating a duplicate.
- Request body: `fullName`, `phone`, `addressLine1`, `addressLine2` (optional), `landmark` (optional), `city`, `state`, six-digit `pincode`, two-letter `country` (defaults to `IN`), and optional `isDefault`.
- Success status: 201

### PATCH /addresses/:id
- Description: Update an active address owned by the authenticated customer.
- Success status: 200

### DELETE /addresses/:id
- Description: Soft-delete an owned address. If it was default, the oldest remaining active address is promoted deterministically; if none remain, no default exists.
- Success status: 200

### PUT /addresses/:id/default
- Description: Set an owned active address as default. Default changes are serialized per customer.
- Success status: 200

## Customer authentication setup

- Apply `migrations/20260919_add_customer_google_identity.sql` through the approved database migration process before deploying the Google/customer-registration code. The migration is additive: it adds `AUTH.google_subject` and a tenant-scoped partial unique index.
- Rollback is only safe after deploying a backend version that no longer accesses `google_subject`; then remove the partial index before removing the column through the approved process.
- Apply `migrations/20260920_add_integration_configurations.sql`, then enable Google for the tenant through the protected integration settings API or Admin UI. The public Google client ID is stored as tenant runtime configuration and returned only when the provider is enabled. Roll it back only after a backend deployment that no longer reads the table, then drop the table through the approved process.
- In Google Cloud, authorize the deployed storefront origins and local development origin as appropriate. Never add OAuth client secrets to the browser.
- `CORS_ORIGINS` must include the deployed storefront origin for browser API calls.
- Apply `migrations/20260921_add_address_tenant_customer_index.sql` before deploying the Address API. It is additive and creates the tenant/customer active-address query index only. Rollback drops that index through the approved process.

## Integration configuration endpoints

### GET /integrations/public/google
- Description: Return the resolved tenant's non-secret Google availability, mode, and public client ID when enabled.
- Success status: 200

### GET /integrations/admin/google
- Description: Read the tenant's non-secret Google configuration.
- Headers: Authorization: Bearer <staffAccessToken>
- Authorization: `ADMIN` or `SUPPORT`
- Success status: 200

### PUT /integrations/admin/google
- Description: Enable/disable the tenant's supported Google Identity Services integration.
- Headers: Authorization: Bearer <staffAccessToken>
- Authorization: `ADMIN` or `SUPPORT`
- Request body:
```json
{
  "isEnabled": true,
  "mode": "ONE_TAP",
  "clientId": "your-client-id.apps.googleusercontent.com"
}
```
- Only the allow-listed `GOOGLE` provider and `ONE_TAP` mode are accepted. Arbitrary provider code, URLs, SQL, scripts, and configuration keys are not accepted.
- OAuth client secrets, webhook secrets, private credentials, JWT settings, password policy, and authentication rules are never stored or returned by these endpoints. Future provider secrets remain in deployment secret storage.

## Environment configuration

Frontend:

- `NEXT_PUBLIC_API_URL` is required for staging and production. Development may use the local API origin when this is omitted.
- `NEXT_PUBLIC_SITE_URL` is the public storefront origin.

Backend:

- `DATABASE_URL`, `DB_SSL`, and `DB_SSL_REJECT_UNAUTHORIZED` configure database connectivity.
- `JWT_SECRET`, `JWT_EXPIRY`, `JWT_REFRESH_SECRET`, and `JWT_REFRESH_EXPIRY` configure application sessions.
- `CORS_ORIGINS` must include the storefront origin.
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_MS`, and `AUTH_RATE_LIMIT_MAX` configure general and authentication-specific request limits.
- `GOOGLE_CLIENT_ID` is not used by the tenant-configured Google Identity Services flow. Do not add Google OAuth client secrets to normal environment files or integration configuration.

## Product Endpoints

### POST /products/admin/products
- Description: Create product with optional image files.
- Headers: Authorization: Bearer <accessToken>
- Content-Type: multipart/form-data
- Body fields:
```json
{
  "name": "string (required)",
  "slug": "string (required)",
  "sku": "string (required)",
  "description": "string",
  "price": "number (required)",
  "compare_price": "number|null",
  "stock_qty": "integer >= 0",
  "category_id": "string|null",
  "collection_id": "string|null",
  "is_published": "boolean",
  "is_featured": "boolean",
  "tags": ["string"],
  "attributes": {},
  "meta_title": "string|null",
  "meta_desc": "string|null"
}
```
- Success status: 201
- Error status: 400, 401, 403, 409, 500

### GET /products/admin/products
- Description: List products with pagination and filters.
- Headers: Authorization: Bearer <accessToken>
- Query:
```json
{
  "page": "integer >= 1",
  "limit": "integer 1..100",
  "category_id": "string",
  "is_published": "boolean",
  "is_featured": "boolean",
  "search": "string",
  "sort_by": "created_at|name|price",
  "sort_order": "asc|desc"
}
```
- Success status: 200
- Error status: 400, 401, 500

### GET /products/admin/products/:productId
- Description: Get product by id (admin).
- Headers: Authorization: Bearer <accessToken>
- Success status: 200
- Error status: 400, 401, 404, 500

### PUT /products/admin/products/:productId
- Description: Update product fields.
- Headers: Authorization: Bearer <accessToken>
- Request body: Same shape as create, all optional, at least one field required.
- Success status: 200
- Error status: 400, 401, 404, 409, 500

### DELETE /products/admin/products/:productId
- Description: Soft-delete product.
- Headers: Authorization: Bearer <accessToken>
- Success status: 200
- Error status: 400, 401, 404, 409, 500

### PUT /products/admin/products/:productId/images
- Description: Upload additional images or set primary image.
- Headers: Authorization: Bearer <accessToken>
- Content-Type: multipart/form-data
- Body fields:
```json
{
  "primary_image_id": "string|null"
}
```
- Success status: 200
- Error status: 400, 401, 404, 500

### DELETE /products/admin/products/:productId/images/:imageId
- Description: Delete product image.
- Headers: Authorization: Bearer <accessToken>
- Success status: 200
- Error status: 400, 401, 404, 500

### GET /products/public/products
- Description: Public product listing (published only).
- Query: Same as admin listing.
- Success status: 200
- Error status: 400, 500

### GET /products/public/products/:productId
- Description: Public product detail (published only).
- Success status: 200
- Error status: 400, 404, 500

## Health

### GET /health
- Description: Service health check.
- Success status: 200

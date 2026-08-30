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
- Description: Authenticate user and return access/refresh token pair.
- Request body:
```json
{
  "email": "user@example.com",
  "password": "string (min 6)"
}
```
- Success status: 200
- Error status: 400, 401, 403, 500

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

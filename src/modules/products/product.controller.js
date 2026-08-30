const productService = require('./product.service');
const heroBannerService = require('./heroBanner.service');
const Logger = require('../../utils/logger');
const ResponseFormatter = require('../../utils/response');
const { NotFoundError } = require('../../utils/errors');



const publicProductCache = new Map();
const PUBLIC_CACHE_TTL_MS = Number(process.env.PUBLIC_PRODUCT_CACHE_TTL_MS || 30000);

const setPublicCache = (key, value) => {
  publicProductCache.set(key, {
    value,
    expiresAt: Date.now() + PUBLIC_CACHE_TTL_MS,
  });
};

const getPublicCache = (key) => {
  const cacheEntry = publicProductCache.get(key);
  if (!cacheEntry) {
    return null;
  }

  if (cacheEntry.expiresAt <= Date.now()) {
    publicProductCache.delete(key);
    return null;
  }

  return cacheEntry.value;
};

exports.createProduct = async (req, res) => {
  const tenantId = req.tenantId;
  const imageFiles = req.files || [];

  const data = await productService.createProduct(tenantId, req.body, imageFiles);

  Logger.info('Product created successfully', { productId: data.id, name: data.name });
  return ResponseFormatter.send(res, {
    statusCode: 201,
    message: 'Product created successfully',
    data,
  });
};



exports.handleEnquiry = async (req, res) => {
  try {
    // // 1. Validate using Joi
    // const { error, value } = enquirySchema.validate(req.body, {
    //   abortEarly: false, // show all errors
    // });

    // if (error) {
    //   return ResponseFormatter.send(res, {
    //     statusCode: 422,
    //     message: "Validation failed",
    //     data: error.details.map((err) => ({
    //       field: err.path[0],
    //       message: err.message,
    //     })),
    //   });
    // }

    // 2. Service call
    console.log("controller req.body =", req.body);
    const enquiry = await productService.processEnquiry(req.body);

    // 3. Log success
    Logger.info("Enquiry created successfully", {
      enquiryId: enquiry.id,
      email: enquiry.email,
    });

    // 4. Response
    return ResponseFormatter.send(res, {
      statusCode: 201,
      message: "Enquiry submitted successfully",
      data: {
        id: enquiry.id,
      },
    });

  } catch (error) {
    Logger.error("Unhandled enquiry error", {
      error: error.message,
      stack: error.stack,
    });

    return ResponseFormatter.send(res, {
      statusCode: 500,
      message: "Something went wrong. Please try again.",
    });
  }
};

//GET /enquiries
exports.getEnquiries = async (req, res) => {
  try {
    const { page, limit, search, status } = req.query;

    const result = await productService.getEnquiries({
      page,
      limit,
      search,
      status,
    });

    console.log("result pagination", result)

    return ResponseFormatter.send(res, {
      statusCode: 200,
      message: "Enquiries fetched successfully",
      data: result,
    });

  } catch (error) {
    Logger.error("Get enquiries controller error", {
      message: error.message,
      query: req.query,
    });

    return ResponseFormatter.send(res, {
      statusCode: 500,
      message: "Failed to fetch enquiries",
    });
  }
};

//GET /enquiries/count?status=new
exports.getEnquiryCount = async (req, res) => {
  try {
    const { status = "new" } = req.query;

    const result = await productService.getEnquiryCount({ status });

    return ResponseFormatter.send(res, {
      statusCode: 200,
      message: "Enquiry count fetched successfully",
      data: result,
    });

  } catch (error) {
    Logger.error("Get enquiry count controller error", {
      message: error.message,
    });

    return ResponseFormatter.send(res, {
      statusCode: 500,
      message: "Failed to fetch enquiry count",
    });
  }
};

// PATCH /enquiries/:id/status
exports.updateEnquiryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // basic validation (you can move this to Joi middleware)
    const allowedStatus = ["new", "contacted", "closed"];

    if (!allowedStatus.includes(status)) {
      return ResponseFormatter.send(res, {
        statusCode: 422,
        message: "Invalid status value",
      });
    }

    const updated = await productService.updateEnquiryStatus(id, status);

    return ResponseFormatter.send(res, {
      statusCode: 200,
      message: "Enquiry status updated successfully",
      data: updated,
    });

  } catch (error) {
    Logger.error("Update enquiry status controller error", {
      id: req.params.id,
      message: error.message,
    });

    if (error.message === "Enquiry not found") {
      return ResponseFormatter.send(res, {
        statusCode: 404,
        message: "Enquiry not found",
      });
    }

    return ResponseFormatter.send(res, {
      statusCode: 500,
      message: "Failed to update enquiry status",
    });
  }
};

exports.getProductList = async (req, res) => {
  const tenantId = req.tenantId;
  const baseApiUrl = resolveBaseApiUrl(req);
  const filters = {
    is_published: req.query.is_published,
    category_id: req.query.category_id,
    is_featured: req.query.is_featured,
    is_best_sell: req.query.is_best_sell,
    search: req.query.search,
    sort_by: req.query.sort_by,
    sort_order: req.query.sort_order,
    limit: req.query.limit,
    page: req.query.page,
  };

  Object.keys(filters).forEach((key) => {
    if (filters[key] === undefined || filters[key] === '' || filters[key] === null) {
      delete filters[key];
    }
  });

  const data = await productService.getProductList(tenantId, filters);
  const formattedProducts = (data.data || []).map((product) => ({
    ...product,
    thumbnail_url: buildImageUrl(product.primary_image_url, baseApiUrl),
  }));

  Logger.info('Products fetched successfully', {
    tenantId,
    count: formattedProducts.length,
  });
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Products fetched successfully',
    data: {
      ...data,
      data: formattedProducts,
    },
  });
};


exports.getProductById = async (req, res) => {
  const { productId } = req.params;
  const tenantId = req.tenantId;
  const baseApiUrl = resolveBaseApiUrl(req);

  const data = await productService.getProductById(tenantId, productId);
  const formattedData = formatProductResponse(data, baseApiUrl);

  Logger.info('Product fetched by ID', { productId });
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Product fetched successfully',
    data: formattedData,
  });
};



exports.updateProduct = async (req, res) => {
  const { productId } = req.params;
  const tenantId = req.tenantId;
  // FIX: Collect any new image files uploaded alongside the field edits.
  // The route now has multer middleware so req.files is populated when the
  // frontend sends a multipart request (which it does whenever images.length > 0).
  const imageFiles = req.files || [];

  const data = await productService.updateProduct(tenantId, productId, req.body, imageFiles);

  Logger.info('Product updated successfully', { productId });
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Product updated successfully',
    data,
  });
};

exports.deleteProduct = async (req, res) => {
  const { productId } = req.params;
  const tenantId = req.tenantId;

  const result = await productService.deleteProduct(tenantId, productId);

  Logger.info('Product deleted successfully', { productId });
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Product deleted successfully',
    data: result,
  });
};

exports.updateProductImages = async (req, res) => {
  const { productId } = req.params;
  const tenantId = req.tenantId;
  const imageFiles = req.files || [];
  const { primary_image_id: primaryImageId } = req.body;

  const data = await productService.updateProductImages(tenantId, productId, imageFiles, primaryImageId);

  Logger.info('Product images updated', { productId, imageCount: imageFiles.length });
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Product images updated successfully',
    data,
  });
};

exports.deleteProductImage = async (req, res) => {
  const { productId, imageId } = req.params;
  const tenantId = req.tenantId;

  const result = await productService.deleteProductImage(tenantId, productId, imageId);

  Logger.info('Product image deleted', { productId, imageId });
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Product image deleted successfully',
    data: result,
  });
};

// Hero banner management deliberately remains in the Product controller/domain.
exports.listHeroBanners = async (req, res) => {
  const data = await heroBannerService.listAdmin(req.tenantId);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Hero banners fetched successfully', data });
};

exports.getHeroBanner = async (req, res) => {
  const data = await heroBannerService.getById(req.tenantId, req.params.bannerId);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Hero banner fetched successfully', data });
};

exports.createHeroBanner = async (req, res) => {
  const data = await heroBannerService.create(req.tenantId, req.body, req.file);
  return ResponseFormatter.send(res, { statusCode: 201, message: 'Hero banner created successfully', data });
};

exports.updateHeroBanner = async (req, res) => {
  const data = await heroBannerService.update(req.tenantId, req.params.bannerId, req.body, req.file);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Hero banner updated successfully', data });
};

exports.deleteHeroBanner = async (req, res) => {
  const data = await heroBannerService.remove(req.tenantId, req.params.bannerId);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Hero banner deleted successfully', data });
};

exports.publishHeroBanner = async (req, res) => {
  const data = await heroBannerService.setPublished(req.tenantId, req.params.bannerId, req.body.is_published);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Hero banner publication updated successfully', data });
};

exports.reorderHeroBanners = async (req, res) => {
  const data = await heroBannerService.reorder(req.tenantId, req.body.banner_type, req.body.ordered_ids);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Hero banners reordered successfully', data });
};

exports.getPublicHeroBanners = async (req, res) => {
  const data = await heroBannerService.listPublic(req.tenantId);
  return ResponseFormatter.send(res, { statusCode: 200, message: 'Hero banners fetched successfully', data });
};

exports.getPublicProducts = async (req, res) => {
  const tenantId = req.tenantId;
  const baseApiUrl = resolveBaseApiUrl(req);

  // req.query is already validated + defaulted by getPublicProductsSchema
  // (page, limit, search, category, rating, inStock, minPrice, maxPrice, sort)
  const { page, limit, search, category, rating, inStock, minPrice, maxPrice, sort } = req.query;
  const filters = { page, limit, search, category, rating, inStock, minPrice, maxPrice, sort };

  const cacheKey = `${tenantId}:${JSON.stringify(filters)}`;
  const cached = getPublicCache(cacheKey);
  if (cached) {
    return ResponseFormatter.send(res, {
      statusCode: 200,
      message: 'Products fetched successfully',
      data: cached,
    });
  }

  const result = await productService.getPublicProductList(tenantId, filters);
  const formattedProducts = (result.data || []).map((product) => ({
    id: product.id,
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    description: product.description,
    price: parseFloat(product.price),
    compare_price: product.compare_price ? parseFloat(product.compare_price) : null,
    stock_qty: product.stock_qty,
    category_id: product.category_id,
    category_name: product.category_name,
    image_urls: product.image_urls,
    is_published: product.is_published,
    is_featured: product.is_featured,
    is_best_sell: product.is_best_sell,
    thumbnail_url: buildImageUrl(product.primary_image_url, baseApiUrl),
    average_rating: Number(Number(product.average_rating || 0).toFixed(1)),
    review_count: Number(product.review_count || 0),
    created_at: product.created_at,
    updated_at: product.updated_at,
  }));

  const payload = {
    products: formattedProducts,
    pagination: result.pagination,
  };

  setPublicCache(cacheKey, payload);

  Logger.info('Public products fetched', {
    tenantId,
    count: formattedProducts.length,
    page: result.pagination.page,
  });
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Products fetched successfully',
    data: payload,
  });
};

// GET /public/products/filters — category list + price bounds for the
// storefront sidebar, cached the same way as the listing itself.
exports.getPublicProductFilters = async (req, res) => {
  const tenantId = req.tenantId;
  const cacheKey = `${tenantId}:filters`;

  const cached = getPublicCache(cacheKey);
  if (cached) {
    return ResponseFormatter.send(res, {
      statusCode: 200,
      message: 'Product filters fetched successfully',
      data: cached,
    });
  }

  const data = await productService.getPublicProductFilters(tenantId);
  setPublicCache(cacheKey, data);

  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Product filters fetched successfully',
    data,
  });
};

exports.getPublicProductById = async (req, res) => {
  const { productId } = req.params;
  const tenantId = req.tenantId;
  const baseApiUrl = resolveBaseApiUrl(req);

  const product = await productService.getProductById(tenantId, productId);

  if (!product.is_published) {
    throw new NotFoundError('Product');
  }

  Logger.info('Public product fetched', { productId });
  return ResponseFormatter.send(res, {
    statusCode: 200,
    message: 'Product fetched successfully',
    data: formatProductResponse(product, baseApiUrl),
  });
};

const formatProductResponse = (product, baseApiUrl) => {
  const normalizedImages = (product.images || [])
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((img) => ({
      id: img.id,
      url: buildImageUrl(img.base_url, baseApiUrl),
      alt_text: img.alt_text,
      is_primary: img.is_primary,
      sort_order: img.sort_order,
    }));

  const primaryImage = normalizedImages.find((img) => img.is_primary) || normalizedImages[0] || null;
  const imageUrls = normalizedImages.map((img) => img.url).filter(Boolean);
  const indexedImageFields = imageUrls.reduce((acc, url, index) => {
    const key = `image_${String(index + 1).padStart(2, '0')}`;
    acc[key] = url;
    return acc;
  }, {});

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    description: product.description,
    price: parseFloat(product.price),
    compare_price: product.compare_price ? parseFloat(product.compare_price) : null,
    stock_qty: product.stock_qty,
    category_id: product.category_id,
    category_name: product.category_name,
    collection_id: product.collection_id,
    collection_name: product.collection_name,
    is_published: product.is_published,
    is_featured: product.is_featured,
    is_best_sell: product.is_best_sell,
    meta_title: product.meta_title,
    meta_desc: product.meta_desc,
    primary_image_url: primaryImage ? primaryImage.url : null,
    image_urls: imageUrls,
    images: normalizedImages,
    ...indexedImageFields,
    created_at: product.created_at,
    updated_at: product.updated_at,
  };
};

const buildImageUrl = (baseUrl, baseApiUrl) => {
  if (!baseUrl) return null;

  // If already a full URL (Supabase), return directly
  if (baseUrl.startsWith("http")) {
    return baseUrl;
  }

  // Fallback for old local files
  const cleanPath = String(baseUrl).replace(/^\/+/, '');
  return `${baseApiUrl}/${cleanPath}`;
};

const resolveBaseApiUrl = (req) => {
  if (process.env.API_URL) {
    return process.env.API_URL.replace(/\/+$/, '');
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.get('host');
  return `${protocol}://${host}`;
};

exports.getAdminReviews = async (req, res, next) => {
  try {
    console.log(" req.user =", req.user);
    const tenantId = req.user.tenant_id;
    console.log("tenantId =", tenantId);
    const {
      page = 1,
      limit = 20,
      status = "pending",
    } = req.query;

    const result = await productService.getAdminReviews(
      tenantId,
      Number(page),
      Number(limit),
      status
    );

    return res.status(200).json({
      success: true,
      message: "Reviews fetched successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.generateReviewInvitations = async (req, res, next) => {
  try {

    console.log("req.params =", req.params);
    console.log("req.user =", req.user);

    const tenantId = req.user.tenant_id;
    const { enquiryId } = req.params;

    console.log("tenantId =", tenantId);
    console.log("enquiryId =", enquiryId);

    const result = await productService.generateReviewInvitations(
      tenantId,
      enquiryId
    );

    return res.status(200).json({
      success: true,
      message: "Review invitations generated successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.getReviewInvitation = async (req, res, next) => {
  try {
    const { inviteCode } = req.params;

    const result = await productService.getReviewInvitation(inviteCode);

    return res.status(200).json({
      success: true,
      message: "Review invitation fetched successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.submitProductReview = async (req, res, next) => {
  try {
    const { inviteCode } = req.params;
    const { rating, review } = req.body;

    const result = await productService.submitProductReview(
      inviteCode,
      rating,
      review
    );

    return res.status(201).json({
      success: true,
      message: "Thank you for your review.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.approveReview = async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;
    const { reviewId } = req.params;

    const result = await productService.approveReview(
      tenantId,
      reviewId
    );

    return res.status(200).json({
      success: true,
      message: "Review approved successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.getProductReviews = async (req, res, next) => {
  try {
    const { productId } = req.params;

    const result = await productService.getProductReviews(productId);

    return res.status(200).json({
      success: true,
      message: "Product reviews fetched successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

exports.updateReviewStatus = async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { approved } = req.body;

    const result = await productService.updateReviewStatus(
      reviewId,
      approved
    );

    return res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
};

exports.updateReview = async (req, res, next) => {
  try {
    const { reviewId } = req.params;
    const { rating, review } = req.body;

    const result = await productService.updateReview(
      reviewId,
      rating,
      review
    );

    res.status(200).json({
      success: true,
      message: "Review updated successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

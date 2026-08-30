const express = require('express');
const multer = require('multer');
const productController = require('./product.controller');
const { authenticate, authorize } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const {
  createProductSchema,
  updateProductSchema,
  productIdParamsSchema,
  getProductsSchema,
  getPublicProductsSchema,
  updateProductImagesSchema,
  deleteProductImageSchema,
  heroBannerIdSchema,
  createHeroBannerSchema,
  updateHeroBannerSchema,
  publishHeroBannerSchema,
  reorderHeroBannersSchema,
  enquirySchema
} = require('./product.validator');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files are allowed'));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: Number(process.env.MAX_FILE_SIZE || 5 * 1024 * 1024),
  },
});

// Hero banners are a Product-domain capability. Custom images use the same
// multer/Supabase path as product images; product-image banners only save IDs.
router.get(
  '/admin/hero-banners',
  authenticate,
  authorize({ roles: ['ADMIN'], userIds: [process.env.SPECIAL_VIEWER_USER_ID].filter(Boolean) }),
  asyncHandler(productController.listHeroBanners)
);
router.get(
  '/admin/hero-banners/:bannerId',
  authenticate,
  authorize({ roles: ['ADMIN'], userIds: [process.env.SPECIAL_VIEWER_USER_ID].filter(Boolean) }),
  validateRequest(heroBannerIdSchema),
  asyncHandler(productController.getHeroBanner)
);
router.post(
  '/admin/hero-banners',
  authenticate,
  authorize({ roles: ['ADMIN'] }),
  upload.single('image'),
  validateRequest(createHeroBannerSchema),
  asyncHandler(productController.createHeroBanner)
);
router.put(
  '/admin/hero-banners/reorder',
  authenticate,
  authorize({ roles: ['ADMIN'] }),
  validateRequest(reorderHeroBannersSchema),
  asyncHandler(productController.reorderHeroBanners)
);
router.put(
  '/admin/hero-banners/:bannerId',
  authenticate,
  authorize({ roles: ['ADMIN'] }),
  upload.single('image'),
  validateRequest(updateHeroBannerSchema),
  asyncHandler(productController.updateHeroBanner)
);
router.delete(
  '/admin/hero-banners/:bannerId',
  authenticate,
  authorize({ roles: ['ADMIN'] }),
  validateRequest(heroBannerIdSchema),
  asyncHandler(productController.deleteHeroBanner)
);
router.patch(
  '/admin/hero-banners/:bannerId/publish',
  authenticate,
  authorize({ roles: ['ADMIN'] }),
  validateRequest(publishHeroBannerSchema),
  asyncHandler(productController.publishHeroBanner)
);
router.get('/public/hero-banners', asyncHandler(productController.getPublicHeroBanners));

router.post(
  '/admin/products',
  authenticate,
  upload.array('images', 10),
  validateRequest(createProductSchema),
  asyncHandler(productController.createProduct)
);

router.post(
  "/enquiry",
  validateRequest(enquirySchema),
  asyncHandler(productController.handleEnquiry)
);

// ---------------------------------------------------
// Admin Enquiries
// GET /products/enquiries
// Supports:
// ?page=1&limit=20&search=test&status=new
// ---------------------------------------------------
router.get(
  "/enquiries",
  // validateRequest(enquiryListQuerySchema, "query"),
  asyncHandler(productController.getEnquiries)
);

// ---------------------------------------------------
// Bell Count
// GET /products/enquiries/count?status=new
// ---------------------------------------------------
router.get(
  "/enquiries/count",
  asyncHandler(productController.getEnquiryCount)
);

// ---------------------------------------------------
// Update Enquiry Status
// PATCH /products/enquiries/:id/status
// ---------------------------------------------------
router.put(
  "/enquiries/:id/status",
  // validateRequest(updateEnquiryStatusSchema),
  asyncHandler(productController.updateEnquiryStatus)
);

router.get(
  '/admin/products',
  authenticate,
  authorize({ roles: ['ADMIN'], userIds: [process.env.SPECIAL_VIEWER_USER_ID].filter(Boolean) }),
  validateRequest(getProductsSchema),
  asyncHandler(productController.getProductList)
);

router.get(
  '/admin/products/:productId',
  authenticate,
  authorize({ roles: ['ADMIN'], userIds: [process.env.SPECIAL_VIEWER_USER_ID].filter(Boolean) }),
  validateRequest(productIdParamsSchema),
  asyncHandler(productController.getProductById)
);

// FIX: Added upload.array('images', 10) so that new image files attached
// during a product update are parsed by multer and available on req.files.
// Without this the files were silently dropped before reaching the controller.
router.put(
  '/admin/products/:productId',
  authenticate,
  upload.array('images', 10),
  validateRequest(updateProductSchema),
  asyncHandler(productController.updateProduct)
);

router.delete(
  '/admin/products/:productId',
  authenticate,
  authorize({ roles: ['ADMIN'] }),
  validateRequest(productIdParamsSchema),
  asyncHandler(productController.deleteProduct)
);

router.put(
  '/admin/products/:productId/images',
  authenticate,
  authorize({ roles: ['ADMIN'] }),
  upload.array('images', 10),
  validateRequest(updateProductImagesSchema),
  asyncHandler(productController.updateProductImages)
);

router.delete(
  '/admin/products/:productId/images/:imageId',
  authenticate,
  validateRequest(deleteProductImageSchema),
  asyncHandler(productController.deleteProductImage)
);

router.get(
  '/public/products',
  validateRequest(getPublicProductsSchema),
  asyncHandler(productController.getPublicProducts)
);

// Must come before '/public/products/:productId' or 'filters' would be
// matched as a productId.
router.get(
  '/public/products/filters',
  asyncHandler(productController.getPublicProductFilters)
);

router.get(
  '/public/products/:productId',
  validateRequest(productIdParamsSchema),
  asyncHandler(productController.getPublicProductById)
);

// Review Invitation Routes

router.get(
  "/admin/reviews",
  authenticate,
  productController.getAdminReviews
);

router.post(
  "/enquiries/:enquiryId/review-invitations",
  authenticate,
  productController.generateReviewInvitations
);

router.get(
  "/reviews/:inviteCode",
  productController.getReviewInvitation
);

router.post(
  "/reviews/:inviteCode",
  productController.submitProductReview
);


router.patch(
  "/reviews/:reviewId/approve",
  authenticate,
  productController.approveReview
);

router.get(
  "/:productId/reviews",
  productController.getProductReviews
);

router.patch(
  "/reviews/:reviewId/status",
  authenticate,
  productController.updateReviewStatus
);

router.patch(
  "/reviews/:reviewId",
  authenticate,
  productController.updateReview
);

module.exports = router;

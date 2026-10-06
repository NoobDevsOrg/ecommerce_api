const express = require('express');
const multer = require('multer');
const productController = require('./product.controller');
const { authenticate, optionalAuthenticate, authorize } = require('../../middleware/auth');
const validateRequest = require('../../middleware/validateRequest');
const {
  createProductSchema,
  updateProductSchema,
  productIdParamsSchema,
  productSlugParamsSchema,
  getProductsSchema,
  getPublicProductsSchema,
  updateProductImagesSchema,
  deleteProductImageSchema,
  heroBannerIdSchema,
  createHeroBannerSchema,
  updateHeroBannerSchema,
  publishHeroBannerSchema,
  reorderHeroBannersSchema,
  testimonialIdSchema,
  createTestimonialSchema,
  updateTestimonialSchema,
  testimonialActiveSchema,
  reorderTestimonialsSchema,
  testimonialSettingsSchema,
  enquirySchema,
  customerEnquiryHistorySchema,
  listEnquiriesSchema,
  enquiryCountSchema,
  updateEnquiryStatusSchema,
  generateReviewInvitationSchema,
  submitReviewSchema,
  reviewInvitationParamsSchema,
  reviewParamsSchema,
} = require('./product.validator');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();
const adminOnly = authorize({ roles: ['ADMIN'] });

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

router.get('/admin/testimonials', authenticate, adminOnly, asyncHandler(productController.listTestimonials));
router.post('/admin/testimonials', authenticate, adminOnly, upload.single('image'), validateRequest(createTestimonialSchema), asyncHandler(productController.createTestimonial));
router.put('/admin/testimonials/reorder', authenticate, adminOnly, validateRequest(reorderTestimonialsSchema), asyncHandler(productController.reorderTestimonials));
router.put('/admin/testimonials/settings', authenticate, adminOnly, validateRequest(testimonialSettingsSchema), asyncHandler(productController.saveTestimonialSettings));
router.put('/admin/testimonials/:testimonialId', authenticate, adminOnly, upload.single('image'), validateRequest(updateTestimonialSchema), asyncHandler(productController.updateTestimonial));
router.delete('/admin/testimonials/:testimonialId', authenticate, adminOnly, validateRequest(testimonialIdSchema), asyncHandler(productController.deleteTestimonial));
router.patch('/admin/testimonials/:testimonialId/active', authenticate, adminOnly, validateRequest(testimonialActiveSchema), asyncHandler(productController.setTestimonialActive));
router.get('/public/testimonials', asyncHandler(productController.getPublicTestimonials));

router.post(
  '/admin/products',
  authenticate,
  adminOnly,
  upload.array('images', 10),
  validateRequest(createProductSchema),
  asyncHandler(productController.createProduct)
);

router.post(
  "/enquiry",
  optionalAuthenticate,
  validateRequest(enquirySchema),
  asyncHandler(productController.handleEnquiry)
);

// Customer-only history. The identity is always derived from the verified
// session; the route deliberately accepts no customer id selector.
router.get(
  "/enquiries/me",
  authenticate,
  validateRequest(customerEnquiryHistorySchema),
  asyncHandler(productController.getMyEnquiries)
);

// ---------------------------------------------------
// Admin Enquiries
// GET /products/enquiries
// Supports:
// ?page=1&limit=20&search=test&status=new
// ---------------------------------------------------
router.get(
  "/enquiries",
  authenticate,
  adminOnly,
  validateRequest(listEnquiriesSchema),
  asyncHandler(productController.getEnquiries)
);

// ---------------------------------------------------
// Bell Count
// GET /products/enquiries/count?status=new
// ---------------------------------------------------
router.get(
  "/enquiries/count",
  authenticate,
  adminOnly,
  validateRequest(enquiryCountSchema),
  asyncHandler(productController.getEnquiryCount)
);

// ---------------------------------------------------
// Update Enquiry Status
// PATCH /products/enquiries/:id/status
// ---------------------------------------------------
router.put(
  "/enquiries/:id/status",
  authenticate,
  adminOnly,
  validateRequest(updateEnquiryStatusSchema),
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
  adminOnly,
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
  '/public/products/slug/:slug',
  validateRequest(productSlugParamsSchema),
  asyncHandler(productController.getPublicProductBySlug)
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
  adminOnly,
  productController.getAdminReviews
);

router.post(
  "/enquiries/:enquiryId/review-invitations",
  authenticate,
  adminOnly,
  validateRequest(generateReviewInvitationSchema),
  productController.generateReviewInvitations
);

router.get(
  "/reviews/:inviteCode",
  validateRequest(reviewInvitationParamsSchema),
  productController.getReviewInvitation
);

router.post(
  "/reviews/:inviteCode",
  validateRequest(submitReviewSchema),
  productController.submitProductReview
);


router.patch(
  "/reviews/:reviewId/approve",
  authenticate,
  adminOnly,
  productController.approveReview
);

router.get(
  "/:productId/reviews",
  validateRequest(reviewParamsSchema),
  productController.getProductReviews
);

router.patch(
  "/reviews/:reviewId/status",
  authenticate,
  adminOnly,
  productController.updateReviewStatus
);

router.patch(
  "/reviews/:reviewId",
  authenticate,
  adminOnly,
  productController.updateReview
);

module.exports = router;

const Logger = require('../utils/logger');
const httpLogs = require('../services/httpLog.service');

const routeTemplate = (req) => {
  if (!req.route?.path) return 'unmatched';
  return `${req.baseUrl || ''}${req.route.path}`;
};

const isRazorpayWebhook = (req) => (req.originalUrl || req.path || '').split('?')[0] === '/webhooks/razorpay';

const requestLogger = (req, res, next) => {
  if (req.path === '/health' || req.path?.startsWith('/uploads/')) return next();
  const startedAt = Date.now();
  let responseBody = null;
  if (typeof res.json === 'function') {
    const originalJson = res.json.bind(res);
    res.json = (body) => { responseBody = body; return originalJson(body); };
  }

  res.on('finish', () => {
    const context = {
      method: req.method,
      route: routeTemplate(req),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
    };
    if (isRazorpayWebhook(req)) {
      // The raw body is needed only by the route handler for HMAC verification.
      // Never put it, headers, or provider payload fields into any log context.
      Object.assign(context, {
        requestId: req.requestId || null,
        provider: 'razorpay',
        eventType: res.locals?.razorpayWebhookLog?.eventType || null,
        eventId: res.locals?.razorpayWebhookLog?.eventId || null,
      });
    } else {
      Object.assign(context, {
        tenantId: req.tenantId || null,
        actorType: req.user?.staff_user_id ? 'staff' : req.user?.customer_id ? 'customer' : 'anonymous',
      });
      if (req.requestId) Object.assign(context, { requestId: req.requestId, actorId: req.user?.id || null, requestBody: req.body, responseBody, errorCode: res.locals?.observabilityErrorCode || null, ipAddress: req.ip || null, userAgent: req.get?.('user-agent') || null });
    }
    Logger.info('HTTP request', context);
    // Diagnostics never delay or fail an application response.
    if (req.requestId) void httpLogs.persist(context).catch((error) => Logger.warn('HTTP request log persistence failed', { requestId: req.requestId, message: error.message }));
  });

  next();
};

module.exports = requestLogger;

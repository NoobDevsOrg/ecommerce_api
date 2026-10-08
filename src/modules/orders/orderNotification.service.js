const crypto = require('crypto');
const pool = require('../../config/db');
const Logger = require('../../utils/logger');
const { sendMail: sharedSendMail } = require('../../utils/smtpTransport');

const ORDER_EVENTS = new Set(['ORDER_PAID', 'ORDER_PROCESSING', 'ORDER_SHIPPED', 'ORDER_DELIVERED']);
const ADMIN_ONLY_EVENTS = new Set(['LOW_STOCK', 'OUT_OF_STOCK', 'ENQUIRY_RECEIVED']);
const ALIASES = { PAYMENT_CONFIRMED: 'ORDER_PAID', PROCESSING: 'ORDER_PROCESSING', SHIPPED: 'ORDER_SHIPPED', DELIVERED: 'ORDER_DELIVERED' };
const eventName = (value) => ALIASES[value] || value;
const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0));
const DEFAULT_BRAND_NAME = 'Sagunthala Dance Jewellers';
const publicHttpsUrl = (value) => {
  try { const url = new URL(String(value || '').trim()); return url.protocol === 'https:' ? url.toString() : null; } catch (_error) { return null; }
};
const publicWebUrl = (value) => {
  try { const url = new URL(String(value || '').trim()); return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null; } catch (_error) { return null; }
};
const displayBrandName = (...values) => values.find((value) => typeof value === 'string' && value.trim() && !/^demo (store|tenant)$/i.test(value.trim()))?.trim() || DEFAULT_BRAND_NAME;
const configuredAdminIdentity = ({ required = true } = {}) => {
  const value = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (typeof value !== 'string' || !value.trim()) {
    if (!required) return { name: null, email: null };
    const error = new Error('Admin notification email is not configured');
    error.code = 'NOTIFICATION_RECIPIENT_NOT_CONFIGURED';
    throw error;
  }
  const email = value.trim();
  const configuredName = typeof process.env.ADMIN_NOTIFICATION_NAME === 'string' && process.env.ADMIN_NOTIFICATION_NAME.trim()
    ? process.env.ADMIN_NOTIFICATION_NAME.trim()
    : null;
  // An email address is an honest configured identity when no display name is
  // configured; never invent the literal "Admin".
  return { name: configuredName || email, email };
};
const adminNotificationRecipient = () => configuredAdminIdentity().email;
const nonEmpty = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;
const recipientTypeFor = (audience) => audience === 'CUSTOMER' ? 'customer' : 'admin';
const identitySnapshot = ({ audience, customerName = null, customerEmail = null, staffName = null, staffEmail = null } = {}) => {
  const recipientType = recipientTypeFor(audience);
  const admin = audience === 'ADMIN' ? configuredAdminIdentity({ required: false }) : null;
  const normalizedCustomerName = nonEmpty(customerName);
  const normalizedCustomerEmail = nonEmpty(customerEmail);
  return {
    recipientType,
    recipientName: recipientType === 'customer'
      ? normalizedCustomerName
      : admin?.name || nonEmpty(staffName) || nonEmpty(staffEmail),
    recipientEmail: recipientType === 'customer'
      ? normalizedCustomerEmail
      : admin?.email || nonEmpty(staffEmail),
    customerName: normalizedCustomerName,
    customerEmail: normalizedCustomerEmail,
  };
};
const emailPayloadIdentity = ({ snapshot = {}, delivery = {} } = {}) => {
  const customerName = nonEmpty(snapshot.customerName) || nonEmpty(delivery.customer_name);
  const customerEmail = nonEmpty(snapshot.customerEmail) || nonEmpty(delivery.customer_email);
  const recipientType = snapshot.recipientType === 'customer' || snapshot.recipientType === 'admin'
    ? snapshot.recipientType
    : recipientTypeFor(delivery.audience_type);
  const configuredAdmin = delivery.audience_type === 'ADMIN' ? configuredAdminIdentity({ required: false }) : null;
  return {
    recipientType,
    recipientName: nonEmpty(snapshot.recipientName)
      || (recipientType === 'customer' ? customerName : configuredAdmin?.name || nonEmpty(delivery.staff_name) || nonEmpty(delivery.staff_email)),
    recipientEmail: recipientType === 'customer'
      ? nonEmpty(snapshot.recipientEmail) || customerEmail
      : configuredAdmin?.email || nonEmpty(snapshot.recipientEmail) || nonEmpty(delivery.staff_email),
    customerName,
    customerEmail,
  };
};
const recipientFor = (delivery) => {
  // Sender credentials are intentionally never destinations. ADMIN is routed
  // through its one explicit deployment configuration; customer delivery is
  // constrained to the customer record selected by the tenant-scoped outbox.
  if (delivery.audience_type === 'ADMIN') return adminNotificationRecipient();
  if (delivery.audience_type === 'CUSTOMER') return emailPayloadIdentity({ snapshot: delivery.content_snapshot, delivery }).recipientEmail || null;
  return delivery.staff_email || null;
};

const origin = () => {
  const raw = process.env.APP_PUBLIC_URL || process.env.FRONTEND_URL;
  if (!raw) return null;
  try { const url = new URL(raw); return process.env.NODE_ENV === 'production' && url.protocol !== 'https:' ? null : url.origin; } catch (_error) { return null; }
};
const fullUrl = (path) => { const base = origin(); return base && path ? new URL(path, `${base}/`).toString() : null; };
const trustedLogo = (tenantLogo) => publicHttpsUrl(process.env.BRAND_LOGO_URL) || publicHttpsUrl(tenantLogo);

const positiveIntegerSetting = (name, fallback, minimum = 1) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
};

// Retry timing is deliberately local to the durable SQL outbox. It is not a
// payment/provider TTL and never changes the business transaction outcome.
const deliveryRetryPolicy = () => {
  const maxAttempts = positiveIntegerSetting('NOTIFICATION_DELIVERY_MAX_ATTEMPTS', 5);
  const baseDelaySeconds = positiveIntegerSetting('NOTIFICATION_DELIVERY_RETRY_BASE_SECONDS', 30);
  const maxDelaySeconds = Math.max(baseDelaySeconds, positiveIntegerSetting('NOTIFICATION_DELIVERY_RETRY_MAX_SECONDS', 3600));
  const staleProcessingSeconds = positiveIntegerSetting('NOTIFICATION_DELIVERY_STALE_PROCESSING_SECONDS', 300);
  return { maxAttempts, baseDelaySeconds, maxDelaySeconds, staleProcessingSeconds };
};

const copyFor = ({ eventType, audience, orderNumber, productName, stockQty, enquiryName, enquiryProductName }) => {
  const customer = {
    ORDER_PAID: ['Your order is confirmed', `We’ve received your payment for order ${orderNumber}. Our team will prepare your jewellery with care.`],
    ORDER_PROCESSING: ['We’re preparing your jewellery', `Your order ${orderNumber} is now being carefully prepared.`],
    ORDER_SHIPPED: ['Your jewellery is on the way', `Order ${orderNumber} has been handed to our delivery partner.`],
    ORDER_DELIVERED: ['Your jewellery has arrived', `Order ${orderNumber} has been marked delivered. We hope it makes your occasion special.`],
    REVIEW_ELIGIBLE: ['Tell us about your experience', `Your thoughts on order ${orderNumber} would mean a lot to us.`],
    PAYMENT_REQUIRES_RECONCILIATION: ['We’re reviewing your order', 'We’ve received your payment and are reviewing your order. You don’t need to pay again. We’ll update you shortly.'],
  };
  const staff = {
    ORDER_PAID: ['New paid order received', `Order ${orderNumber} has a trusted payment confirmation.`],
    ORDER_PROCESSING: ['Order moved to processing', `Order ${orderNumber} is now in fulfillment.`],
    ORDER_SHIPPED: ['Order shipped', `Order ${orderNumber} has been dispatched.`],
    ORDER_DELIVERED: ['Order delivered', `Order ${orderNumber} was marked delivered.`],
    PAYMENT_REQUIRES_RECONCILIATION: ['Payment needs reconciliation', `A trusted payment for order ${orderNumber} needs operational review before fulfillment.`],
    LOW_STOCK: ['Low stock alert', `${productName || 'A product'} is low on stock (${stockQty} remaining).`],
    OUT_OF_STOCK: ['Out of stock', `${productName || 'A product'} is no longer available for purchase.`],
    ENQUIRY_RECEIVED: ['New enquiry received', enquiryName ? `${enquiryName} asked about ${enquiryProductName || 'your jewellery collection'}.` : `Guest enquiry for ${enquiryProductName || 'your jewellery collection'}.`],
  };
  return (audience === 'CUSTOMER' ? customer : staff)[eventType] || ['Account update', 'There is a new update for your account.'];
};
const actionFor = ({ eventType, audience, orderNumber, paymentReference, productId, enquiryReference }) => {
  if (audience === 'CUSTOMER' && ORDER_EVENTS.has(eventType)) return `/account/orders/${encodeURIComponent(orderNumber)}`;
  if (audience === 'CUSTOMER' && eventType === 'REVIEW_ELIGIBLE') return `/account/orders/${encodeURIComponent(orderNumber)}#review`;
  if (audience === 'CUSTOMER' && eventType === 'PAYMENT_REQUIRES_RECONCILIATION') return `/account/orders/${encodeURIComponent(orderNumber)}`;
  if (audience !== 'CUSTOMER' && ORDER_EVENTS.has(eventType)) return `/admin/orders/${encodeURIComponent(orderNumber)}`;
  if (eventType === 'PAYMENT_REQUIRES_RECONCILIATION') return paymentReference ? `/admin/payments/${encodeURIComponent(paymentReference)}` : '/admin/payments';
  if (eventType === 'LOW_STOCK' || eventType === 'OUT_OF_STOCK') return `/admin/inventory?productId=${encodeURIComponent(productId)}`;
  if (eventType === 'ENQUIRY_RECEIVED') return `/admin/enquiries?search=${encodeURIComponent(enquiryReference)}`;
  return null;
};

const getOrder = async (client, tenantId, orderId) => {
  const result = await client.query(`SELECT o.id,o.order_number,o.total_amount,o.courier_name,o.tracking_number,o.tracking_url,c.id AS customer_id,c.full_name AS customer_name,c.email AS customer_email,t.brand_name,t.logo_url,
    (SELECT COALESCE(p.razorpay_payment_id,p.id) FROM PAYMENTS p WHERE p.tenant_id=o.tenant_id AND p.order_id=o.id AND p.is_deleted=false ORDER BY p.created_at DESC LIMIT 1) AS payment_reference
    FROM ORDERS o JOIN CUSTOMERS c ON c.id=o.customer_id AND c.tenant_id=o.tenant_id JOIN TENANTS t ON t.id=o.tenant_id
    WHERE o.tenant_id=$1 AND o.id=$2 AND o.is_deleted=false`, [tenantId, orderId]);
  return result.rows[0] || null;
};
const getEnquiry = async (client, tenantId, enquiryId) => {
  const result = await client.query(`SELECT e.id,e.reference,e.customer_id,COALESCE(NULLIF(c.full_name,''),NULLIF(e.name,'')) AS customer_name,COALESCE(NULLIF(c.email,''),NULLIF(e.email,'')) AS customer_email,e.phone,e.message,e.created_at,
    COALESCE(json_agg(json_build_object('id',p.id,'name',p.name,'image_url',pi.base_url) ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL), '[]') AS products
    FROM ENQUIRIES e
    LEFT JOIN CUSTOMERS c ON c.id=e.customer_id AND c.tenant_id=e.tenant_id
    LEFT JOIN ENQUIRY_PRODUCTS ep ON ep.enquiry_id=e.id AND ep.tenant_id=e.tenant_id
    LEFT JOIN PRODUCTS p ON p.id=ep.product_id AND p.tenant_id=e.tenant_id
    LEFT JOIN LATERAL (SELECT base_url FROM PRODUCT_IMAGES WHERE product_id=p.id AND tenant_id=p.tenant_id AND is_primary=true LIMIT 1) pi ON true
    WHERE e.tenant_id=$1 AND e.id=$2 GROUP BY e.id,c.full_name,c.email`, [tenantId, enquiryId]);
  return result.rows[0] || null;
};

// Called inside each trusted business transaction. Unique recipient/event keys
// make repeated callbacks and webhooks create no additional in-app entries or emails.
const enqueueInTransaction = async (client, { tenantId, orderId, eventType, entityType = 'ORDER', entityId = orderId, productId, productName, stockQty, paymentReference }) => {
  const type = eventName(eventType);
  const order = entityType === 'ORDER' ? await getOrder(client, tenantId, orderId) : null;
  const enquiry = entityType === 'ENQUIRY' ? await getEnquiry(client, tenantId, entityId) : null;
  const recipients = [];
  if (!ADMIN_ONLY_EVENTS.has(type) && order?.customer_id) recipients.push({ audience: 'CUSTOMER', customerId: order.customer_id, key: `customer:${order.customer_id}` });
  if (type !== 'REVIEW_ELIGIBLE') {
    const staff = await client.query(`SELECT s.id,s.full_name,s.email,r.code FROM STAFF_USERS s JOIN ROLES r ON r.id=s.role_id AND r.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.is_active=true AND r.code IN ('ADMIN','SUPPORT') ORDER BY CASE r.code WHEN 'ADMIN' THEN 0 ELSE 1 END${type === 'ENQUIRY_RECEIVED' ? ' LIMIT 1' : ''}`, [tenantId]);
    for (const member of staff.rows) recipients.push({ audience: member.code, staffId: member.id, staffName: member.full_name, staffEmail: member.email, key: `staff:${member.id}` });
  }
  const created = [];
  for (const recipient of recipients) {
    const enquiryProductName = enquiry?.products?.[0]?.name || null;
    const [title, message] = copyFor({ eventType: type, audience: recipient.audience, orderNumber: order?.order_number, productName, stockQty, enquiryName: enquiry?.name, enquiryProductName });
    const path = actionFor({ eventType: type, audience: recipient.audience, orderNumber: order?.order_number, paymentReference: paymentReference || order?.payment_reference, productId, enquiryReference: enquiry?.reference });
    const customerName = order?.customer_name || enquiry?.customer_name || null;
    const customerEmail = order?.customer_email || enquiry?.customer_email || null;
    const identity = identitySnapshot({ audience: recipient.audience, customerName, customerEmail, staffName: recipient.staffName, staffEmail: recipient.staffEmail });
    const snapshot = {
      title,
      message,
      action_label: type === 'ENQUIRY_RECEIVED' ? 'View enquiry' : recipient.audience === 'CUSTOMER' ? 'View your order' : 'Open in admin',
      ...identity,
      related: enquiry
        ? { enquiry_reference: enquiry.reference, customer_name: customerName, email: customerEmail, phone: enquiry.phone, message: enquiry.message, products: enquiry.products, submitted_at: enquiry.created_at, is_guest: !enquiry.customer_id }
        : order ? { order_number: order.order_number }
          : { product_id: productId || null, product_name: productName || null },
    };
    const result = await client.query(`INSERT INTO NOTIFICATIONS (id,tenant_id,audience_type,customer_id,staff_id,recipient_key,event_type,entity_type,entity_id,title,message,action_url,content_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
      ON CONFLICT (tenant_id,event_type,entity_type,entity_id,recipient_key) DO NOTHING RETURNING id`,
    [crypto.randomUUID(), tenantId, recipient.audience, recipient.customerId || null, recipient.staffId || null, recipient.key, type, entityType, entityId, title, message, fullUrl(path), JSON.stringify(snapshot)]);
    if (result.rows[0]) { await client.query(`INSERT INTO NOTIFICATION_DELIVERIES (id,notification_id,tenant_id,channel) VALUES ($1,$2,$3,'EMAIL')`, [crypto.randomUUID(), result.rows[0].id, tenantId]); created.push(result.rows[0].id); }
  }
  return created;
};

const emailLayout = ({ brandName, logo, title, message, actionUrl, actionLabel, eventType, identity = {}, order, enquiry, items = [] }) => {
  const safeBrandName = displayBrandName(brandName); const safeLogo = publicHttpsUrl(logo); const safeActionUrl = publicWebUrl(actionUrl); const trackingUrl = publicWebUrl(order?.tracking_url);
  const recipientName = nonEmpty(identity.recipientName);
  const greeting = recipientName ? `<p style="margin:0 0 16px;color:#514a40;font-size:16px;line-height:1.6">Hello ${escapeHtml(recipientName)},</p>` : '';
  const reviewEvent = eventType === 'REVIEW_ELIGIBLE';
  const paymentEvent = eventType === 'ORDER_PAID' || eventType === 'PAYMENT_REQUIRES_RECONCILIATION';
  const rows = items.map((item) => { const imageUrl = publicHttpsUrl(item.image_url); return `<tr><td style="padding:12px 0;border-top:1px solid #eee7dc;color:#28231d;font-size:15px;line-height:1.4">${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(item.product_name)}" width="56" height="56" style="border:1px solid #e8decc;border-radius:6px;object-fit:cover;vertical-align:middle;margin-right:12px"/>` : ''}${escapeHtml(item.product_name)}</td><td style="padding:12px 0;border-top:1px solid #eee7dc;text-align:right;color:#9b7429;font-weight:bold">×${Number(item.quantity)}</td></tr>`; }).join('');
  const tracking = order?.tracking_number ? `<p style="margin:12px 0 0;color:#413a30;font-size:14px">Tracking: ${trackingUrl ? `<a href="${escapeHtml(trackingUrl)}" style="color:#9b7429;font-weight:bold;text-decoration:underline">${escapeHtml(order.tracking_number)}</a>` : escapeHtml(order.tracking_number)}</p>` : '';
  const trackingCta = trackingUrl ? `<p style="margin:12px 0 0"><a href="${escapeHtml(trackingUrl)}" style="display:inline-block;border:1px solid #b48a3c;color:#79591d;text-decoration:none;font-weight:bold;padding:11px 16px;border-radius:5px">Track your shipment</a></p>` : '';
  const enquiryBlock = enquiry ? `<div style="margin-top:24px;padding:18px;background:#fcfaf6;border:1px solid #eee5d7;border-radius:8px"><p style="margin:0;color:#9b7429;font-weight:bold">Enquiry ${escapeHtml(enquiry.enquiry_reference || '')}</p><p style="margin:8px 0 0;color:#413a30"><strong>Customer:</strong> ${escapeHtml(enquiry.customer_name || (enquiry.is_guest ? 'Guest' : 'Not provided'))}</p><p style="margin:6px 0 0;color:#413a30"><strong>Email:</strong> ${escapeHtml(enquiry.email || 'Not provided')}</p>${enquiry.phone ? `<p style="margin:6px 0 0;color:#413a30"><strong>Phone:</strong> ${escapeHtml(enquiry.phone)}</p>` : ''}${enquiry.products?.length ? `<p style="margin:6px 0 0;color:#413a30"><strong>Product:</strong> ${escapeHtml(enquiry.products.map((product) => product.name).filter(Boolean).join(', '))}</p>` : ''}${enquiry.message ? `<p style="margin:12px 0 0;color:#413a30;white-space:pre-wrap"><strong>Message:</strong> ${escapeHtml(enquiry.message)}</p>` : ''}</div>` : '';
  const orderHeading = reviewEvent ? `Review for order ${escapeHtml(order?.order_number)}` : `Order ${escapeHtml(order?.order_number)}`;
  const amountLabel = paymentEvent ? 'Payment amount' : 'Order total';
  const paymentStatus = paymentEvent ? `<p style="margin:8px 0 0;color:#413a30"><strong>Payment:</strong> ${eventType === 'ORDER_PAID' ? 'received' : 'under review'}</p>` : '';
  const html = `<div style="margin:0;padding:24px;background:#faf8f4;font-family:Arial,sans-serif;color:#28231d"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;margin:auto;background:#ffffff;border:1px solid #e9e1d4;border-radius:12px;box-shadow:0 2px 10px rgba(63,45,18,0.08)"><tr><td style="padding:32px"><div style="text-align:center;color:#9b7429;font-size:12px;letter-spacing:2px;font-weight:bold">${safeLogo ? `<img src="${escapeHtml(safeLogo)}" alt="${escapeHtml(safeBrandName)}" style="max-height:54px;max-width:200px;display:block;margin:0 auto 12px"/>` : ''}${escapeHtml(safeBrandName)}</div><h1 style="margin:26px 0 12px;color:#28231d;font-size:27px;line-height:1.25">${escapeHtml(title)}</h1>${greeting}<p style="margin:0;color:#514a40;font-size:16px;line-height:1.6">${escapeHtml(message)}</p>${enquiryBlock}${order ? `<div style="margin-top:24px;padding:18px;background:#fcfaf6;border:1px solid #eee5d7;border-radius:8px"><p style="margin:0;color:#9b7429;font-weight:bold">${orderHeading}</p><p style="margin:8px 0 0;color:#413a30">${amountLabel}: ${escapeHtml(money(order.total_amount))}</p>${paymentStatus}${rows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px">${rows}</table>` : ''}${tracking}${trackingCta}</div>` : ''}${safeActionUrl ? `<p style="margin:28px 0 18px"><a href="${escapeHtml(safeActionUrl)}" style="display:inline-block;background:#b48a3c;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 20px;border-radius:6px">${escapeHtml(actionLabel)}</a></p>` : ''}<p style="margin:28px 0 0;border-top:1px solid #ece5da;padding-top:18px;color:#756c60;font-size:12px;line-height:1.6">Thank you for choosing ${escapeHtml(safeBrandName)}.</p></td></tr></table></div>`;
  return { html, text: [title, recipientName && `Hello ${recipientName},`, message, enquiry && `Enquiry: ${enquiry.enquiry_reference || ''}`, enquiry?.customer_name && `Customer: ${enquiry.customer_name}`, enquiry?.email && `Email: ${enquiry.email}`, enquiry?.phone && `Phone: ${enquiry.phone}`, enquiry?.products?.length && `Product: ${enquiry.products.map((product) => product.name).join(', ')}`, enquiry?.message && `Message: ${enquiry.message}`, order && (reviewEvent ? `Review for order: ${order.order_number}` : `Order: ${order.order_number}`), order && `${amountLabel}: ${money(order.total_amount)}`, paymentEvent && `Payment: ${eventType === 'ORDER_PAID' ? 'received' : 'under review'}`, order?.tracking_number && `Tracking: ${order.tracking_number}`, trackingUrl && `Track your shipment: ${trackingUrl}`, safeActionUrl && `${actionLabel}: ${safeActionUrl}`, `Thank you for choosing ${safeBrandName}.`].filter(Boolean).join('\n\n') };
};

const claimNext = async ({ tenantId, entityId, database = pool }) => {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const policy = deliveryRetryPolicy();
    const parameters = entityId
      ? [tenantId, entityId, policy.maxAttempts, policy.baseDelaySeconds, policy.maxDelaySeconds, policy.staleProcessingSeconds]
      : [tenantId, policy.maxAttempts, policy.baseDelaySeconds, policy.maxDelaySeconds, policy.staleProcessingSeconds];
    const entityClause = entityId ? 'AND n.entity_id=$2' : '';
    const policyOffset = entityId ? 2 : 1;
    const maxAttempts = `$${policyOffset + 1}`;
    const baseDelaySeconds = `$${policyOffset + 2}`;
    const maxDelaySeconds = `$${policyOffset + 3}`;
    const staleProcessingSeconds = `$${policyOffset + 4}`;
    const result = await client.query(`SELECT d.id AS delivery_id,n.event_type,n.entity_type,n.entity_id,n.title,n.message,n.action_url,n.content_snapshot,n.audience_type,o.order_number,o.total_amount,o.tracking_number,o.tracking_url,t.brand_name,t.name AS tenant_name,t.logo_url,c.full_name AS customer_name,c.email AS customer_email,s.full_name AS staff_name,s.email AS staff_email
      FROM NOTIFICATION_DELIVERIES d JOIN NOTIFICATIONS n ON n.id=d.notification_id AND n.tenant_id=d.tenant_id LEFT JOIN CUSTOMERS c ON c.id=n.customer_id AND c.tenant_id=n.tenant_id LEFT JOIN STAFF_USERS s ON s.id=n.staff_id AND s.tenant_id=n.tenant_id LEFT JOIN ORDERS o ON n.entity_type='ORDER' AND o.id=n.entity_id AND o.tenant_id=n.tenant_id JOIN TENANTS t ON t.id=n.tenant_id
      WHERE d.tenant_id=$1 AND d.channel='EMAIL' ${entityClause}
        AND (
          d.status='PENDING'
          OR (d.status='FAILED' AND d.attempts < ${maxAttempts}
              AND d.updated_at <= now() - (LEAST(${baseDelaySeconds}::numeric * power(2, GREATEST(d.attempts - 1, 0)), ${maxDelaySeconds}::numeric) * interval '1 second'))
          OR (d.status='PROCESSING' AND d.attempts < ${maxAttempts}
              AND d.updated_at <= now() - (${staleProcessingSeconds}::numeric * interval '1 second'))
        )
      ORDER BY d.created_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1`, parameters);
    const delivery = result.rows[0]; if (!delivery) { await client.query('COMMIT'); return null; }
    const claimed = await client.query(`UPDATE NOTIFICATION_DELIVERIES SET status='PROCESSING',attempts=attempts+1,last_error_code=NULL,updated_at=now() WHERE id=$1 RETURNING attempts`, [delivery.delivery_id]);
    const attempt = await client.query(`INSERT INTO NOTIFICATION_DELIVERY_ATTEMPTS (id,delivery_id,tenant_id,attempt_number,status) VALUES ($1,$2,$3,$4,'PROCESSING') RETURNING id`, [crypto.randomUUID(), delivery.delivery_id, tenantId, claimed.rows[0].attempts]);
    await client.query('COMMIT'); return { ...delivery, attempt_id: attempt.rows[0].id };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
};
const dispatchForOrder = async ({ tenantId, orderId, entityId = orderId, database = pool, sendMail = sharedSendMail } = {}) => {
  const outcomes = [];
  for (;;) {
    const delivery = await claimNext({ tenantId, entityId, database }); if (!delivery) break;
    try {
      const items = delivery.entity_type === 'ORDER' ? await database.query(`SELECT product_name,quantity,image_url FROM ORDER_ITEMS WHERE tenant_id=$1 AND order_id=$2 AND is_deleted=false ORDER BY created_at,id`, [tenantId, entityId]) : { rows: [] };
      const actionLabel = delivery.audience_type === 'CUSTOMER'
        ? (delivery.event_type === 'REVIEW_ELIGIBLE' ? 'Review your purchase' : 'View your order')
        : 'Open in admin';
      const identity = emailPayloadIdentity({ snapshot: delivery.content_snapshot, delivery });
      const layout = emailLayout({ brandName: displayBrandName(delivery.brand_name, delivery.tenant_name), logo: trustedLogo(delivery.logo_url), title: delivery.title, message: delivery.message, actionUrl: delivery.action_url, actionLabel: delivery.event_type === 'ENQUIRY_RECEIVED' ? 'View enquiry' : actionLabel, eventType: delivery.event_type, identity, order: delivery.order_number ? delivery : null, enquiry: delivery.content_snapshot?.related || null, items: items.rows });
      const recipient = recipientFor(delivery);
      if (!recipient) {
        const error = new Error('Notification recipient is not available');
        error.code = 'NOTIFICATION_RECIPIENT_NOT_CONFIGURED';
        throw error;
      }
      await sendMail({ to: recipient, subject: delivery.title, ...layout });
      await database.query(`UPDATE NOTIFICATION_DELIVERIES SET status='SENT',sent_at=now(),updated_at=now() WHERE id=$1 AND status='PROCESSING'`, [delivery.delivery_id]); await database.query(`UPDATE NOTIFICATION_DELIVERY_ATTEMPTS SET status='SENT',completed_at=now() WHERE id=$1`, [delivery.attempt_id]); outcomes.push({ eventType: delivery.event_type, status: 'SENT' });
    } catch (error) { const code = error?.code === 'NOTIFICATION_RECIPIENT_NOT_CONFIGURED' ? 'DELIVERY_CONFIGURATION_ERROR' : 'DELIVERY_FAILED'; await database.query(`UPDATE NOTIFICATION_DELIVERIES SET status='FAILED',last_error_code=$2,updated_at=now() WHERE id=$1 AND status='PROCESSING'`, [delivery.delivery_id, code]); await database.query(`UPDATE NOTIFICATION_DELIVERY_ATTEMPTS SET status='FAILED',safe_error_code=$2,completed_at=now() WHERE id=$1`, [delivery.attempt_id, code]); outcomes.push({ eventType: delivery.event_type, status: 'FAILED', errorCode: code }); }
  }
  return outcomes;
};
const dispatchSafely = (input) => dispatchForOrder(input).catch(() => Logger.warn('Notification dispatch could not start', { tenantId: input.tenantId, entityId: input.orderId || input.entityId }));
module.exports = { enqueueInTransaction, dispatchForOrder, dispatchSafely, claimNext, emailLayout, copyFor, actionFor, eventName, recipientFor, configuredAdminIdentity, identitySnapshot, emailPayloadIdentity, displayBrandName, publicHttpsUrl, deliveryRetryPolicy };

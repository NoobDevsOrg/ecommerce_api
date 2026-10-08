const pool = require('../../config/db');
const { NotFoundError } = require('../../utils/errors');
const { emailPayloadIdentity } = require('../orders/orderNotification.service');

const recipientWhere = (audience, user, values) => {
  if (audience === 'CUSTOMER') { values.push(user.customer_id); return `n.audience_type='CUSTOMER' AND n.customer_id=$${values.length}`; }
  values.push(user.staff_user_id); return `n.audience_type IN ('ADMIN','SUPPORT') AND n.staff_id=$${values.length}`;
};
const present = (row) => ({ id: row.id, eventType: row.event_type, title: row.title, message: row.message, actionUrl: row.action_url || null, readAt: row.read_at || null, createdAt: row.created_at });
const staffOwnership = (user, values) => { values.push(user.staff_user_id); return `n.audience_type IN ('ADMIN','SUPPORT') AND n.staff_id=$${values.length}`; };

const list = async ({ tenantId, audience, user, page = 1, limit = 20 }) => {
  const values = [tenantId]; const ownership = recipientWhere(audience, user, values); const offset = (page - 1) * limit;
  const [count, unread, rows] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM NOTIFICATIONS n WHERE n.tenant_id=$1 AND ${ownership}`, values),
    pool.query(`SELECT COUNT(*)::int AS total FROM NOTIFICATIONS n WHERE n.tenant_id=$1 AND ${ownership} AND n.read_at IS NULL`, values),
    pool.query(`SELECT n.id,n.event_type,n.title,n.message,n.action_url,n.read_at,n.created_at FROM NOTIFICATIONS n WHERE n.tenant_id=$1 AND ${ownership} ORDER BY n.created_at DESC,n.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]),
  ]);
  const total = Number(count.rows[0]?.total || 0);
  return { notifications: rows.rows.map(present), unreadCount: Number(unread.rows[0]?.total || 0), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasNext: page * limit < total, hasPrevious: page > 1 } };
};
const markRead = async ({ tenantId, audience, user, id }) => {
  const values = [tenantId]; const ownership = recipientWhere(audience, user, values); values.push(id);
  const result = await pool.query(`UPDATE NOTIFICATIONS n SET read_at=COALESCE(read_at,now()) WHERE n.tenant_id=$1 AND ${ownership} AND n.id=$${values.length} RETURNING n.id,n.event_type,n.title,n.message,n.action_url,n.read_at,n.created_at`, values);
  if (!result.rows[0]) throw new NotFoundError('Notification'); return present(result.rows[0]);
};
const markAllRead = async ({ tenantId, audience, user }) => {
  const values = [tenantId]; const ownership = recipientWhere(audience, user, values);
  const result = await pool.query(`UPDATE NOTIFICATIONS n SET read_at=now() WHERE n.tenant_id=$1 AND ${ownership} AND n.read_at IS NULL`, values);
  return { markedRead: result.rowCount || 0 };
};
const safeError = (code) => code === 'DELIVERY_CONFIGURATION_ERROR' ? 'Delivery configuration needs attention.' : code === 'DELIVERY_FAILED' ? 'Email delivery failed and will retry if eligible.' : null;
const getAdminDetail = async ({ tenantId, user, id }) => {
  const values = [tenantId]; const ownership = staffOwnership(user, values); values.push(id);
  const result = await pool.query(`SELECT n.*, c.full_name AS customer_name,c.email AS customer_email,s.full_name AS staff_name,s.email AS staff_email
    FROM NOTIFICATIONS n LEFT JOIN CUSTOMERS c ON c.id=n.customer_id AND c.tenant_id=n.tenant_id LEFT JOIN STAFF_USERS s ON s.id=n.staff_id AND s.tenant_id=n.tenant_id
    WHERE n.tenant_id=$1 AND ${ownership} AND n.id=$${values.length}`, values);
  const notification = result.rows[0]; if (!notification) throw new NotFoundError('Notification');
  const deliveries = await pool.query(`SELECT d.*,
    COALESCE((SELECT json_agg(json_build_object('id',a.id,'attemptNumber',a.attempt_number,'status',a.status,'safeError',a.safe_error_code,'startedAt',a.started_at,'completedAt',a.completed_at) ORDER BY a.attempt_number) FROM NOTIFICATION_DELIVERY_ATTEMPTS a WHERE a.delivery_id=d.id), '[]') AS attempt_history
    FROM NOTIFICATION_DELIVERIES d WHERE d.notification_id=$1 AND d.tenant_id=$2 ORDER BY d.channel`, [id, tenantId]);
  const related = notification.content_snapshot?.related || { entity_id: notification.entity_id };
  const identity = emailPayloadIdentity({ snapshot: notification.content_snapshot, delivery: notification });
  const emailRecipient = identity.recipientEmail || null;
  const email = deliveries.rows.map((delivery) => ({ id: delivery.id, channel: delivery.channel, status: delivery.status, attempts: Number(delivery.attempts || 0), sentAt: delivery.sent_at || null, createdAt: delivery.created_at, updatedAt: delivery.updated_at, nextRetryAt: delivery.status === 'FAILED' ? delivery.updated_at : null, safeError: safeError(delivery.last_error_code), attemptHistory: delivery.attempt_history || [] }));
  const inApp = { channel: 'IN_APP', status: notification.read_at ? 'READ' : 'DELIVERED', createdAt: notification.created_at, readAt: notification.read_at || null, attempts: 1, attemptHistory: [{ attemptNumber: 1, status: 'DELIVERED', startedAt: notification.created_at, completedAt: notification.created_at }] };
  const logicalStatus = notification.read_at ? 'READ' : email.some((delivery) => delivery.status === 'SENT') ? 'DELIVERED' : email.some((delivery) => delivery.status === 'FAILED') ? 'FAILED' : 'PENDING';
  return { notification: { ...present(notification), entityType: notification.entity_type, entityId: notification.entity_id, audienceType: notification.audience_type, updatedAt: notification.updated_at || notification.created_at, status: logicalStatus, content: { subject: notification.content_snapshot?.title || notification.title, message: notification.content_snapshot?.message || notification.message, ctaLabel: notification.content_snapshot?.action_label || 'Open update', ctaDestination: notification.action_url || null }, related, technical: { notificationId: notification.id, eventType: notification.event_type, eventKey: `${notification.event_type}:${notification.entity_id}`, entityType: notification.entity_type, entityId: notification.entity_id, createdAt: notification.created_at, updatedAt: notification.updated_at || notification.created_at, readAt: notification.read_at || null } }, recipients: [{ audience: identity.recipientType, name: identity.recipientName, address: emailRecipient, channel: 'EMAIL' }].filter((recipient) => recipient.address), channels: [inApp, ...email] };
};
const listForEntity = async ({ tenantId, user, entityType, entityId }) => {
  const values = [tenantId]; const ownership = staffOwnership(user, values); values.push(entityType, entityId);
  const rows = await pool.query(`SELECT n.id,n.event_type,n.title,n.message,n.action_url,n.read_at,n.created_at,
    COALESCE((SELECT json_agg(json_build_object('channel',d.channel,'status',d.status,'attempts',d.attempts,'sentAt',d.sent_at)) FROM NOTIFICATION_DELIVERIES d WHERE d.notification_id=n.id), '[]') AS deliveries
    FROM NOTIFICATIONS n WHERE n.tenant_id=$1 AND ${ownership} AND n.entity_type=$${values.length - 1} AND n.entity_id=$${values.length} ORDER BY n.created_at DESC`, values);
  return rows.rows.map((row) => ({ ...present(row), deliveries: row.deliveries || [] }));
};
module.exports = { list, markRead, markAllRead, getAdminDetail, listForEntity };

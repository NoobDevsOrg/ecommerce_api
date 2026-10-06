const { AppError } = require('./errors');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const assertDateRange = ({ from, to } = {}) => {
  if (from && !ISO_DATE.test(from)) throw new AppError('From date must be YYYY-MM-DD', 400, 'INVALID_DATE_RANGE');
  if (to && !ISO_DATE.test(to)) throw new AppError('To date must be YYYY-MM-DD', 400, 'INVALID_DATE_RANGE');
  if (from && to && to < from) throw new AppError('To date cannot be before from date', 400, 'INVALID_DATE_RANGE');
};

const addInclusiveDateRange = (where, values, column, { from, to }) => {
  assertDateRange({ from, to });
  // Admin dates represent the same calendar day as the fixed admin display zone.
  // Convert explicit local midnights to instants so the database session timezone
  // cannot move a boundary by one day.
  if (from) { values.push(from); where.push(`${column} >= ($${values.length}::date::timestamp AT TIME ZONE 'Asia/Kolkata')`); }
  if (to) { values.push(to); where.push(`${column} < (($${values.length}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Kolkata')`); }
};

const csv = (columns, rows) => [columns.map((column) => column.label).join(','), ...rows.map((row) => columns.map((column) => `"${String(column.value(row) ?? '').replace(/"/g, '""')}"`).join(','))].join('\r\n');

module.exports = { assertDateRange, addInclusiveDateRange, csv };

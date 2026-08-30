/**
 * Validation utilities for common checks
 */

class ValidationUtils {
  // Email validation
  static isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  // UUID validation (v4)
  static isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  // Slug validation (alphanumeric, hyphens)
  static isValidSlug(slug) {
    const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    return slugRegex.test(slug);
  }

  // Numerical validation
  static isValidPrice(price) {
    const num = parseFloat(price);
    return !isNaN(num) && num >= 0;
  }

  static isValidInteger(value, min = 0, max = null) {
    const num = parseInt(value);
    if (isNaN(num)) return false;
    if (num < min) return false;
    if (max !== null && num > max) return false;
    return true;
  }

  // String length validation
  static isValidLength(str, min = 1, max = null) {
    if (typeof str !== 'string') return false;
    if (str.length < min) return false;
    if (max !== null && str.length > max) return false;
    return true;
  }

  // Sanitize input to prevent SQL injection
  static sanitizeString(str) {
    if (typeof str !== 'string') return '';
    return str.trim().replace(/[<>'"]/g, '');
  }

  // Validate date format (YYYY-MM-DD)
  static isValidDateFormat(dateString) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateString)) return false;
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date);
  }

  // Batch validation
  static validateRequired(obj, requiredFields) {
    const missing = [];
    for (const field of requiredFields) {
      if (!obj[field]) {
        missing.push(field);
      }
    }
    return { isValid: missing.length === 0, missing };
  }
}

module.exports = ValidationUtils;

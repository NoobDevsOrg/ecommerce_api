const { v4: uuidv4 } = require('uuid');

/**
 * Utility helper functions
 */

class Helper {
  /**
   * Generate a UUID v4
   */
  static generateId() {
    return uuidv4();
  }

  /**
   * Generate a slug from text
   * Example: "Hello World" -> "hello-world"
   */
  static generateSlug(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
      .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
  }

  /**
   * Generate a unique slug by appending a counter
   */
  static generateUniqueSlug(baseSlug, counter = 1) {
    if (counter === 1) return baseSlug;
    return `${baseSlug}-${counter}`;
  }

  /**
   * Convert string to boolean
   */
  static toBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      return value.toLowerCase() === 'true' || value === '1';
    }
    return !!value;
  }

  /**
   * Convert string to integer safely
   */
  static toInteger(value, defaultValue = 0) {
    const num = parseInt(value);
    return isNaN(num) ? defaultValue : num;
  }

  /**
   * Convert string to float safely
   */
  static toFloat(value, defaultValue = 0) {
    const num = parseFloat(value);
    return isNaN(num) ? defaultValue : num;
  }

  /**
   * Paginate array
   */
  static paginate(array, page = 1, limit = 20) {
    const start = (page - 1) * limit;
    const end = start + limit;
    return {
      data: array.slice(start, end),
      pagination: {
        page,
        limit,
        total: array.length,
        pages: Math.ceil(array.length / limit),
      },
    };
  }

  /**
   * Deep clone object
   */
  static deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Check if object is empty
   */
  static isEmpty(obj) {
    return Object.keys(obj).length === 0;
  }

  /**
   * Merge objects
   */
  static merge(target, ...sources) {
    return Object.assign(target, ...sources);
  }

  /**
   * Pick specific keys from object
   */
  static pick(obj, keys) {
    const result = {};
    keys.forEach((key) => {
      if (key in obj) {
        result[key] = obj[key];
      }
    });
    return result;
  }

  /**
   * Omit specific keys from object
   */
  static omit(obj, keys) {
    const result = { ...obj };
    keys.forEach((key) => {
      delete result[key];
    });
    return result;
  }

  /**
   * Format price with decimal places
   */
  static formatPrice(price, decimals = 2) {
    return parseFloat(price).toFixed(decimals);
  }

  /**
   * Generate order number
   */
  static generateOrderNumber() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 7).toUpperCase();
    return `ORD-${timestamp}-${random}`;
  }

  /**
   * Generate SKU from product name
   */
  static generateSKU(productName, counter = 1) {
    const initials = productName
      .split(' ')
      .slice(0, 3)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
    const timestamp = Date.now().toString().slice(-4);
    return `${initials}-${timestamp}-${String(counter).padStart(3, '0')}`;
  }

  /**
   * Calculate discount percentage
   */
  static calculateDiscountPercent(originalPrice, discountedPrice) {
    if (originalPrice === 0) return 0;
    return Math.round(((originalPrice - discountedPrice) / originalPrice) * 100);
  }

  /**
   * Capitalize first letter
   */
  static capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Convert array to comma-separated string
   */
  static arrayToString(arr) {
    return Array.isArray(arr) ? arr.join(', ') : arr;
  }

  /**
   * Convert comma-separated string to array
   */
  static stringToArray(str) {
    if (Array.isArray(str)) return str;
    if (!str) return [];
    return str.split(',').map((item) => item.trim());
  }

  /**
   * Wait for specified milliseconds
   */
  static async delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = Helper;

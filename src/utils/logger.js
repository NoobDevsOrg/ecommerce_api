const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const SENSITIVE_KEYS = ['password', 'password_hash', 'token', 'authorization', 'cookie'];

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const colors = {
  error: '\x1b[31m',
  warn: '\x1b[33m',
  info: '\x1b[36m',
  debug: '\x1b[35m',
  reset: '\x1b[0m',
};

class Logger {
  static maskSensitive(data) {
    if (Array.isArray(data)) {
      return data.map((item) => this.maskSensitive(item));
    }

    if (data && typeof data === 'object') {
      const clone = {};
      Object.keys(data).forEach((key) => {
        if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
          clone[key] = '***';
          return;
        }

        clone[key] = this.maskSensitive(data[key]);
      });

      return clone;
    }

    return data;
  }

  static log(level, message, data = null) {
    if (levels[level] > levels[LOG_LEVEL]) return;

    const timestamp = new Date().toISOString();
    const color = colors[level] || '';
    const reset = colors.reset;

    let output = `${color}[${timestamp}] [${level.toUpperCase()}]${reset} ${message}`;

    if (data) {
      output += ` ${JSON.stringify(this.maskSensitive(data))}`;
    }

    console.log(output);
  }

  static error(message, data = null) {
    this.log('error', message, data);
  }

  static warn(message, data = null) {
    this.log('warn', message, data);
  }

  static info(message, data = null) {
    this.log('info', message, data);
  }

  static debug(message, data = null) {
    this.log('debug', message, data);
  }
}

module.exports = Logger;

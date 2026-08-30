class ResponseFormatter {
  static success({ statusCode = 200, message = 'Success', data = null } = {}) {
    return {
      success: true,
      statusCode,
      message,
      data,
    };
  }

  static error({
    statusCode = 500,
    message = 'Internal server error',
    errorCode = 'INTERNAL_SERVER_ERROR',
    details,
  } = {}) {
    const error = { code: errorCode };

    if (details !== undefined) {
      error.details = details;
    }

    return {
      success: false,
      statusCode,
      message,
      error,
    };
  }

  static send(res, { statusCode = 200, message = 'Success', data = null } = {}) {
    return res.status(statusCode).json(
      this.success({
        statusCode,
        message,
        data,
      })
    );
  }

  static sendError(
    res,
    {
      statusCode = 500,
      message = 'Internal server error',
      errorCode = 'INTERNAL_SERVER_ERROR',
      details,
    } = {}
  ) {
    return res.status(statusCode).json(
      this.error({
        statusCode,
        message,
        errorCode,
        details,
      })
    );
  }
}

module.exports = ResponseFormatter;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorHandler(error, _request, response, _next) {
  if (error instanceof HttpError) {
    return response
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
  }
  if (error.type === 'entity.too.large') {
    return response
      .status(413)
      .json({
        error: { code: 'payload_too_large', message: 'Request body exceeds the allowed size.' },
      });
  }
  if (error.type === 'entity.parse.failed') {
    return response
      .status(400)
      .json({ error: { code: 'invalid_json', message: 'Request body must be valid JSON.' } });
  }
  // Log a code only. Database errors can include credentials, SQL, or uploaded values.
  console.error('API operation failed', { code: error.code || 'internal_error' });
  return response
    .status(500)
    .json({ error: { code: 'internal_error', message: 'The request could not be completed.' } });
}

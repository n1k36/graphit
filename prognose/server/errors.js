export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const unauthorized = (message = 'You need to sign in first.') => new HttpError(401, message);
export const forbidden = (message = 'You are not allowed to do that.') => new HttpError(403, message);
export const notFound = (message = 'Not found.') => new HttpError(404, message);

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, code = 'E_BAD_REQUEST') {
    return new ApiError(400, code, message);
  }
  static unauthorized(message = '请先登录') {
    return new ApiError(401, 'E_UNAUTHENTICATED', message);
  }
  static forbidden(message = '没有访问权限') {
    return new ApiError(403, 'E_FORBIDDEN', message);
  }
  static notFound(message = '资源不存在') {
    return new ApiError(404, 'E_NOT_FOUND', message);
  }
  static conflict(message: string, code = 'E_CONFLICT') {
    return new ApiError(409, code, message);
  }
}

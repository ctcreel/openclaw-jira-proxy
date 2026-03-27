import type { Request, Response } from 'express';

import { buildHealthResponse } from '../services/health.service';

export function getHealth(_request: Request, response: Response): void {
  const health = buildHealthResponse();
  const statusCode = health.status === 'healthy' ? 200 : 503;
  response.status(statusCode).json(health);
}

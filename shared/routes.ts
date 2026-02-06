import { z } from 'zod';

// Minimal routes file - bot doesn't need REST API
export const api = {
  health: {
    method: 'GET' as const,
    path: '/api/health',
    responses: {
      200: z.object({ status: z.string() }),
    },
  },
};

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}

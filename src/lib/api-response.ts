import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

export interface ApiErrorShape {
  success: false;
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

export function apiError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
  requestId = randomUUID(),
) {
  return NextResponse.json(
    {
      success: false,
      error: {
        code,
        message,
        requestId,
        ...(details !== undefined ? { details } : {}),
      },
    } satisfies ApiErrorShape,
    { status },
  );
}

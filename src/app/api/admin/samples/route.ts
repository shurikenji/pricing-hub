import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { isAdminRequest } from "@/lib/admin-auth";
import {
  appendAuditLog,
  deleteServerSample,
  getServerSampleById,
  listServerSamples,
  upsertServerSample,
} from "@/lib/server-db";
import type { SamplePayloadType, ServerSamplePayload } from "@/lib/types";

type SampleBody = {
  id?: string;
  serverId?: string;
  sampleType?: SamplePayloadType;
  label?: string;
  notes?: string;
  payloadJson?: string;
  cloneFromId?: string;
};

function getActor(request: Request) {
  return request.headers.get("x-forwarded-for") || "admin-session";
}

function validateSampleBody(body: SampleBody) {
  if (!body.serverId || !body.sampleType || !body.label || !body.payloadJson) {
    return "Missing serverId, sampleType, label, or payloadJson.";
  }

  try {
    JSON.parse(body.payloadJson);
  } catch {
    return "payloadJson must be valid JSON.";
  }

  return null;
}

export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId") || undefined;
  const sampleType = (searchParams.get("sampleType") || undefined) as SamplePayloadType | undefined;
  const id = searchParams.get("id");

  if (id) {
    const sample = getServerSampleById(id);
    if (!sample) {
      return apiError("SAMPLE_NOT_FOUND", "Sample not found", 404);
    }
    return NextResponse.json(sample);
  }

  return NextResponse.json(listServerSamples(serverId, sampleType));
}

export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const body = (await request.json().catch(() => null)) as SampleBody | null;
  if (!body) {
    return apiError("INVALID_SAMPLE_REQUEST", "Invalid sample request", 400);
  }

  if (body.cloneFromId) {
    const source = getServerSampleById(body.cloneFromId);
    if (!source) {
      return apiError("SAMPLE_NOT_FOUND", "Source sample not found", 404);
    }

    const cloned: ServerSamplePayload = {
      ...source,
      id: randomUUID(),
      label: `${source.label} (copy)`,
      version: source.version + 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    upsertServerSample(cloned);
    appendAuditLog({
      action: "sample.cloned",
      targetType: "sample",
      targetId: cloned.id,
      detail: JSON.stringify({
        actor: getActor(request),
        sourceId: source.id,
        serverId: cloned.serverId,
        sampleType: cloned.sampleType,
      }),
    });
    return NextResponse.json(cloned);
  }

  const validationError = validateSampleBody(body);
  if (validationError) {
    return apiError("INVALID_SAMPLE", validationError, 400);
  }

  const now = Date.now();
  const sample: ServerSamplePayload = {
    id: randomUUID(),
    serverId: body.serverId!,
    sampleType: body.sampleType!,
    label: body.label!,
    notes: body.notes,
    payloadJson: body.payloadJson!,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  upsertServerSample(sample);
  appendAuditLog({
    action: "sample.created",
    targetType: "sample",
    targetId: sample.id,
    detail: JSON.stringify({
      actor: getActor(request),
      serverId: sample.serverId,
      sampleType: sample.sampleType,
      label: sample.label,
    }),
  });

  return NextResponse.json(sample);
}

export async function PUT(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const body = (await request.json().catch(() => null)) as SampleBody | null;
  if (!body?.id) {
    return apiError("SAMPLE_ID_REQUIRED", "Missing sample id", 400);
  }

  const existing = getServerSampleById(body.id);
  if (!existing) {
    return apiError("SAMPLE_NOT_FOUND", "Sample not found", 404);
  }

  const next: ServerSamplePayload = {
    ...existing,
    serverId: body.serverId ?? existing.serverId,
    sampleType: body.sampleType ?? existing.sampleType,
    label: body.label ?? existing.label,
    notes: body.notes ?? existing.notes,
    payloadJson: body.payloadJson ?? existing.payloadJson,
    version: existing.version + 1,
    updatedAt: Date.now(),
  };

  const validationError = validateSampleBody(next);
  if (validationError) {
    return apiError("INVALID_SAMPLE", validationError, 400);
  }

  upsertServerSample(next);
  appendAuditLog({
    action: "sample.updated",
    targetType: "sample",
    targetId: next.id,
    detail: JSON.stringify({
      actor: getActor(request),
      serverId: next.serverId,
      version: next.version,
    }),
  });

  return NextResponse.json(next);
}

export async function DELETE(request: Request) {
  if (!isAdminRequest(request)) {
    return apiError("UNAUTHORIZED", "Unauthorized", 401);
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return apiError("SAMPLE_ID_REQUIRED", "Missing sample id", 400);
  }

  const ok = deleteServerSample(id);
  if (!ok) {
    return apiError("SAMPLE_NOT_FOUND", "Sample not found", 404);
  }

  appendAuditLog({
    action: "sample.deleted",
    targetType: "sample",
    targetId: id,
    detail: JSON.stringify({ actor: getActor(request) }),
  });

  return NextResponse.json({ success: true });
}

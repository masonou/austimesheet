"use server";

import { revalidatePath } from "next/cache";
import { requireWorkspace } from "@/lib/workspace";
import { sameOrigin, validUuid } from "@/lib/kiosk/server";
import { readPages } from "@/lib/records";

export type SessionChange = {
  operation: "create" | "edit" | "review" | "reopen" | "void";
  id: string;
  employee: string;
  revision: number | null;
  start?: string | null;
  finish?: string | null;
  note?: string | null;
  reason?: string;
};

export async function changeSession(org: string, change: SessionChange) {
  if (
    !(await sameOrigin()) ||
    !validUuid(org) ||
    !validUuid(change?.id) ||
    !validUuid(change.employee)
  )
    return { error: "Session unavailable." };
  const { client } = await requireWorkspace(org, "admin");
  const { data, error } = await client
    .rpc("manage_work_session", {
      org,
      employee: change.employee,
      session_id: change.id,
      operation: change.operation,
      expected_revision: change.revision,
      start_time: change.start ?? null,
      finish_time: change.finish ?? null,
      session_note: change.note ?? null,
      change_reason: change.reason ?? null,
    })
    .retry(false);
  if (error) {
    if (error.code === "23P01")
      return {
        error: "These times overlap another session for this employee.",
      };
    if (error.code === "23505" || error.message === "Session changed")
      return {
        error:
          "This session changed. Close and reopen its details to see the latest record.",
        stale: true,
      };
    if (error.message === "Invalid shift times")
      return {
        error:
          "Check the start and finish. The finish must follow the start and recorded times must be in the past.",
      };
    if (error.code === "P0001") return { error: error.message };
    return {
      error:
        "Could not confirm the change. Refresh the timesheet before trying again.",
    };
  }
  revalidatePath("/workspace/" + org + "/admin");
  revalidatePath("/workspace/" + org + "/employee");
  return { error: "", revision: Number(data) };
}

export type HistoryEntry = {
  id: string;
  event: string;
  changed_at: string;
  changed_by: string;
  reason: string;
  old_started_at: string | null;
  old_ended_at: string | null;
  new_started_at: string | null;
  new_ended_at: string | null;
  before_state: { note: string | null } | null;
  after_state: { note: string | null } | null;
};
export async function sessionHistory(org: string, id: string) {
  if (!(await sameOrigin()) || !validUuid(org) || !validUuid(id))
    throw new Error("Session unavailable.");
  const { client } = await requireWorkspace(org, "admin");
  return readPages<HistoryEntry>((from, to) =>
    client
      .from("timesheet_edit_history")
      .select(
        "id,event,changed_at,changed_by,reason,old_started_at,old_ended_at,new_started_at,new_ended_at,before_state,after_state",
        { count: "exact" },
      )
      .eq("organisation_id", org)
      .eq("session_id", id)
      .order("changed_at", { ascending: false })
      .order("id")
      .range(from, to),
  );
}

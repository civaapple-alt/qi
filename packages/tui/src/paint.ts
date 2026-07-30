import type { SessionEvent } from "@civaapple/qi-protocol";

/**
 * Whether a Session event can change chat transcript lines.
 * Chrome-only facts update Working / footer via projection without invalidating the dashboard.
 */
export function eventAffectsTranscript(event: SessionEvent): boolean {
  const type = event.type;
  // A denial is the Action's visible terminal settlement (`⊘`), so it must
  // repaint the transcript. Requested/granted are transient chrome facts;
  // action.started will repaint after a grant.
  if (type === "authority.requested" || type === "authority.granted") return false;
  if (type.startsWith("safety.")) return false;
  if (type === "context.compiled") return false;
  if (type.startsWith("workspace.mount.") || type.startsWith("workspace.sensitive_path.")) return false;
  if (type.startsWith("memory.")) return false;
  if (type.startsWith("presence.")) return false;
  if (type.startsWith("session.archive") || type.startsWith("session.restore")) return false;
  if (type === "session.model.configured") return false;
  return true;
}

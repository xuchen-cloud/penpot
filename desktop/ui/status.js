export function runtimeAction(status) {
  if (status.phase === "ready") {
    return { command: "start_instance" };
  }
  if (status.phase === "running") {
    if (!status.publicUrl) {
      throw new Error("The running desktop status has no public URL.");
    }
    return { publicUrl: status.publicUrl };
  }
  return null;
}

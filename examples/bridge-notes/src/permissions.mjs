export const NOTES_ROOT_ID = "notes-import";
export const NOTES_ROOT_DISPLAY = "[local]/Bridge Notes import";

export function bridgeNotesPermissions() {
  return {
    version: "AUTH-SCOPE-v2",
    preset: "bridge-notes-cli",
    request_source: "bridge_notes_cli",
    capabilities: ["codex.chat", "data.put", "data.get", "data.query", "data.delete", "fs.read", "fs.write"],
    workspace_roots: [{ id: "default", path_display: "[local]/Bridge Notes workspace" }],
    sandbox_floor: "workspace-write",
    approval_policy_floor: "on-request",
    allow_approval_never: false,
    allow_developer_instructions: false,
    boundaries: {
      data: {
        type: "namespace_kv",
        allow_query: true,
        allow_delete: true,
        max_key_bytes: 512,
        max_value_bytes: 262144,
      },
      fs: {
        type: "directory_whitelist",
        allowed_roots: [{ id: NOTES_ROOT_ID, path_display: NOTES_ROOT_DISPLAY }],
        write_roots: [{ id: NOTES_ROOT_ID, path_display: NOTES_ROOT_DISPLAY }],
        writable: true,
        max_bytes: 8388608,
        follow_symlinks: false,
      },
    },
  };
}

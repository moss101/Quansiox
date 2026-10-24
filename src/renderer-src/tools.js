/* The tools the agent can call.
 *
 * One list, two surfaces: the permission matrix (which tool may do what)
 * and the command palette (which tool exists). They must not drift, so the
 * list lives here and both read it.
 */

export const TOOL_GROUPS = [
  {
    label: 'Files & shell',
    tools: ['shell', 'read_file', 'write_file', 'edit_file', 'glob_files', 'list_dir', 'search_code'],
  },
  {
    label: 'Computer & browser',
    tools: ['computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_open_app', 'browser_open', 'browser_click', 'browser_type', 'browser_fill', 'browser_fill_credentials', 'browser_import_cookies'],
  },
  {
    label: 'Outward-facing',
    tools: ['email_send', 'slack_post_message', 'messages_send', 'github_pr_create'],
  },
  {
    label: 'Delegation',
    tools: ['task', 'team', 'message_subagent', 'wake_parent'],
  },
];

/** Every tool, with the group it belongs to. */
export const TOOLS = TOOL_GROUPS.flatMap((group) => group.tools.map((name) => ({ name, group: group.label })));

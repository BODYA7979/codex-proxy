/** Scope instructions are repeated at the inference boundary so app-server
 * permission metadata and compacted histories cannot redefine client access. */
export const CALLER_PERMISSION_INSTRUCTIONS = `<caller_tool_execution_boundary>
The Codex sandbox, approval policy, filesystem permissions and working directory describe ONLY the proxy/app-server environment. They do not describe the external client machine.
Respect the user's instructions and the client's own declared policies. The presence of a tool is not authorization for an unrelated operation. All supplied function tools execute on the external client. Client paths refer to that client's environment. Determine which client operations are available from the supplied tools and their actual results.
Do not declare the client read-only, unable to write files, or unable to run commands because the proxy has a read-only sandbox. If a client edit, write or shell tool is available and needed, request it. A successful result confirms that operation succeeded on the client.
If a client tool reports a permission error, explain that specific failed client operation based on the returned result. Do not infer a blanket client restriction from proxy sandbox metadata, and do not claim an operation succeeded without its result.
The proxy cannot execute native operational tools for you. Its restriction must never be used as a reason to refuse an available client tool.
</caller_tool_execution_boundary>`;

export function isCompactionRequest(body: Record<string, unknown>): boolean {
  return Array.isArray(body.input) && body.input.at(-1)?.type === "compaction_trigger";
}

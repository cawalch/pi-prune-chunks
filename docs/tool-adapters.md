# Tool Adapters

The collector recognizes generic Pi tools plus Reamer and FlowTrace families.

Generic families:

- file reads: `read`, `file_read`, `view_file`, `open_file`, `cat`
- searches: `search`, `ffgrep`, `grep`, `rg`, `ripgrep`
- shell: `shell`, `bash`, `command`, `exec_command`, `terminal`
- tests: `test`, `npm_test`, `pytest`, `go_test`
- diffs: `diff`, `git_diff`

Shell adapters inspect read-only commands before falling back to generic shell
classification. `sed -n`, `cat`, `head`, `tail`, and `nl | sed` are treated as
file reads with source path and line range when the command exposes them.
`grep`, `rg`, and `ffgrep` commands are treated as search chunks and retain the
command plus best-effort source path.

Reamer families:

- `code_context`, `code_search`, `code_search_symbols`
- `code_read_range`, `code_read_symbol`, `code_outline`, `code_related`
- `code_pattern_search`, `code_semantic_search`, `code_flow_trace`

FlowTrace families:

- `flow_trace`, `flow_path`, `flow_impact`

Adapters infer kind, risk, label, source path, line range, command, token
estimate, and short summary from tool name, parameters, command text, and
content.

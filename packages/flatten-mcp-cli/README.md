# flatten-mcp-cli

Bin-name companion for [flatten-mcp](https://www.npmjs.com/package/flatten-mcp), so this
works directly:

```bash
echo '[{"role":"user","content":"hi"}]' | npx flatten-mcp-cli --flatten
```

`npx <command>` installs the npm package with that exact name; the actual
`flatten-mcp-cli` bin ships inside the `flatten-mcp` package. This package is a one-line
delegate to it — no logic of its own — published by the same maintainer so the command
name resolves (and cannot be claimed by anyone else).

Equivalent without this package: `npx -y -p flatten-mcp flatten-mcp-cli ...`

Full documentation, tools, and source:
**[github.com/shayaShav/flatten-mcp](https://github.com/shayaShav/flatten-mcp)**

# flatten-mcp-http

Bin-name companion for [flatten-mcp](https://www.npmjs.com/package/flatten-mcp), so this
works directly:

```bash
npx flatten-mcp-http            # POST http://127.0.0.1:8787/mcp (Streamable HTTP)
```

`npx <command>` installs the npm package with that exact name; the actual
`flatten-mcp-http` server bin ships inside the `flatten-mcp` package. This package is a
one-line delegate to it — no logic of its own — published by the same maintainer so the
command name resolves (and cannot be claimed by anyone else).

Equivalent without this package: `npx -y -p flatten-mcp flatten-mcp-http ...`

Full documentation, tools, and source:
**[github.com/shayaShav/flatten-mcp](https://github.com/shayaShav/flatten-mcp)**

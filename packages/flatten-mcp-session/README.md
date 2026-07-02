# flatten-mcp-session

Bin-name companion for [flatten-mcp](https://www.npmjs.com/package/flatten-mcp), so this
works directly:

```bash
npx flatten-mcp-session flatten --dry-run
```

`npx <command>` installs the npm package with that exact name; the actual
`flatten-mcp-session` CLI ships inside the `flatten-mcp` package. This package is a
one-line delegate to it — no logic of its own — published by the same maintainer so the
command name resolves (and cannot be claimed by anyone else).

Equivalent without this package: `npx -y -p flatten-mcp flatten-mcp-session ...`

Full documentation, tools, and source:
**[github.com/shayaShav/flatten-mcp](https://github.com/shayaShav/flatten-mcp)**

#!/usr/bin/env node
// Delegates to the real CLI inside the flatten-mcp package (which executes on
// import). This package exists so `npx flatten-mcp-cli` resolves — npx installs
// the package matching the command name, and the bin itself ships inside
// flatten-mcp.
import 'flatten-mcp/cli';

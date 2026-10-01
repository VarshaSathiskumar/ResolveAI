# ResolveAI

An Alexa+-style troubleshooting agent for home products, built on a self-hosted MCP server (Streamable HTTP) with agentic RAG. Built for the Amazon Developer Hackathon.

Status: in development.

## Development

```bash
npm install
MCP_BEARER_TOKEN=dev-token npm run dev:server   # MCP server on http://127.0.0.1:3000/mcp
npm run ingest                                  # build data/resolveai.db from corpus/ (downloads the embedding model on first run)
npm run ingest -- --embedder hash               # offline, non-semantic embeddings for quick checks
npm test
npm run test:model -w @resolveai/server         # opt-in: calibration eval against the real embedding model
```

The server needs the index first, so run `npm run ingest` before starting it. Set `RESOLVEAI_EMBEDDER=hash` (and ingest with `--embedder hash`) to run fully offline.

`corpus/` holds synthetic Brewwell coffee machine manuals, troubleshooting guides and warranty terms, plus `demo.json` with three demo users (one machine, two machines, none).

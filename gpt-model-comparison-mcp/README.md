# GPT Model Comparison MCP Server

An MCP server that helps LLMs and applications select optimal GPT models based on task requirements and cost considerations.

## Features

- **Smart Model Selection**: Recommends optimal models based on task type, token needs, and budget
- **Cost Estimation**: Predicts token usage and costs for any text prompt
- **Model Comparison**: Compare GPT models side-by-side across various dimensions
- **Detailed Documentation**: Includes a `/schema` endpoint with complete parameter information

## Available Tools

- `get_optimal_model`: Get the optimal model based on task requirements
- `estimate_text_cost`: Analyze text to estimate costs across models (now with output size control)
- `get_model_details`: Get comprehensive information about a specific model
- `compare_models`: Compare multiple models side-by-side
- `list_models`: Get a complete list of all available models with optional categorization

## Running Locally

```bash
npm install
npm start
```

The server will be available at:
- Homepage: http://localhost:8787/
- MCP endpoint: http://localhost:8787/sse
- Documentation: http://localhost:8787/schema

## Connect from MCP Inspector

1. Run `npx @modelcontextprotocol/inspector@latest`
2. Connect to http://localhost:8787/sse

## Deploy to Cloudflare

```bash
npx wrangler deploy
```

After deployment, your MCP server will be available at `https://gpt-model-comparison-mcp.[your-subdomain].workers.dev/sse`.

## Connect to Claude or other LLMs

Use the mcp-remote proxy to connect from Claude or other MCP-compatible LLMs:

```bash
npx mcp-remote --origin=http://localhost:8787/sse
```

Or for a deployed server:

```bash
npx mcp-remote --origin=https://gpt-model-comparison-mcp.[your-subdomain].workers.dev/sse
```

## Tool Examples

### Get Optimal Model

```json
{
  "task_type": "code_generation",
  "context_length": 5000,
  "multimodal_required": false,
  "optimize_for": "cost"
}
```

### Estimate Text Cost

```json
{
  "text": "Write a story about robots",
  "models": ["GPT-4.1", "GPT-4o-Mini"],
  "expected_output": "detailed"
}
```

### Compare Models

```json
{
  "models": ["GPT-4.1", "GPT-4o", "GPT-4.1-Mini"],
  "comparison_aspects": ["pricing", "multimodal", "strengths"]
}
```

### List Models

```json
{
  "categories": ["flagship", "cost-optimized"],
  "include_details": true
}
```
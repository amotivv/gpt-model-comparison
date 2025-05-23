import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { models, TaskType } from './models';
import { 
  detectTaskType,
  detectVerbosity,
  estimateOutputTokens,
  countTokens,
  findOptimalModel,
  approximateTokenCount
} from './utils';

// Define our MCP agent with tools
export class GptModelComparisonMCP extends McpAgent {
	server = new McpServer({
		name: "GPT Model Comparison",
		version: "1.0.0",
		description: "Tools for comparing and selecting optimal GPT models based on task requirements and cost considerations"
	});

	async init() {
		// Tool 1: Get optimal model based on task requirements
		this.server.tool(
			"get_optimal_model",
			{
				task_type: z.enum(["code_generation", "creative_writing", "qa", "summarization", "general"]),
				context_length: z.number().default(1000),
				multimodal_required: z.boolean().default(false),
				optimize_for: z.enum(["cost", "performance", "balanced"]).default("balanced"),
				max_budget: z.number().optional(),
				required_features: z.array(z.string()).optional()
			},
			async ({ task_type, context_length, multimodal_required, optimize_for, max_budget, required_features }) => {
				// Find the optimal model based on requirements
				const result = findOptimalModel({
					taskType: task_type as TaskType,
					contextLength: context_length,
					multimodalRequired: multimodal_required,
					optimizeFor: optimize_for as "cost" | "performance" | "balanced",
					maxBudget: max_budget,
					requiredFeatures: required_features
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(result, null, 2)
						}
					]
				};
			}
		);

		// Tool 2: Estimate text cost
		this.server.tool(
			"estimate_text_cost",
			{
				text: z.string(),
				models: z.array(z.string()).optional(),
				force_brevity: z.boolean().default(false),
				expected_output: z.union([
					z.number(), // Exact token count
					z.enum(["brief", "medium", "detailed"]) // Predefined categories
				]).optional()
			},
			async ({ text, models: requestedModels, force_brevity, expected_output }) => {
				// Calculate token count
				const inputTokens = await countTokens(text).catch(error => {
					console.error("Error counting tokens:", error);
					return approximateTokenCount(text);
				});

				// Detect task type and verbosity
				const taskType = detectTaskType(text);
				const verbosity = force_brevity ? "low" : detectVerbosity(text);

				// Estimate output tokens - either use expected_output or estimate automatically
				let outputEstimate;
				
				if (expected_output !== undefined) {
					if (typeof expected_output === "number") {
						// Direct token count
						const count = expected_output;
						outputEstimate = {
							conservative: Math.round(count * 0.7), // 30% less than expected
							expected: count,
							maximum: Math.round(count * 1.5) // 50% more than expected
						};
					} else {
						// Category selection
						const tokenMap = {
							"brief": 100,
							"medium": 500, 
							"detailed": 1500
						};
						const count = tokenMap[expected_output];
						outputEstimate = {
							conservative: Math.round(count * 0.7),
							expected: count,
							maximum: Math.round(count * 1.5)
						};
					}
				} else {
					// Fall back to the existing estimation logic
					outputEstimate = estimateOutputTokens(inputTokens, taskType, verbosity);
				}

				// Calculate costs for requested models or default to popular ones
				const modelsToCheck = requestedModels || 
					["GPT-4.1", "GPT-4o", "GPT-4.1-Mini", "GPT-4o-Mini", "GPT-3.5-Turbo"];
				
				const modelEstimates = modelsToCheck
					.filter(modelName => models[modelName]) // Filter out invalid model names
					.map(modelName => {
						const model = models[modelName];
						
						const inputCost = (inputTokens / 1000000) * model.pricing.input;
						const outputCosts = {
							conservative: (outputEstimate.conservative / 1000000) * model.pricing.output,
							expected: (outputEstimate.expected / 1000000) * model.pricing.output,
							maximum: (outputEstimate.maximum / 1000000) * model.pricing.output
						};

						return {
							model: modelName,
							input_cost: `$${inputCost.toFixed(6)}`,
							output_estimates: {
								conservative: { 
									tokens: outputEstimate.conservative, 
									cost: `$${outputCosts.conservative.toFixed(6)}` 
								},
								expected: { 
									tokens: outputEstimate.expected, 
									cost: `$${outputCosts.expected.toFixed(6)}` 
								},
								maximum: { 
									tokens: outputEstimate.maximum, 
									cost: `$${outputCosts.maximum.toFixed(6)}` 
								}
							},
							total_cost_ranges: `$${(inputCost + outputCosts.conservative).toFixed(6)} - $${(inputCost + outputCosts.maximum).toFixed(6)}`
						};
					});

				// Find cheapest model based on expected output
				let cheapestModel = modelEstimates[0]?.model || "Unknown";
				let lowestExpectedCost = Number.MAX_VALUE;
				
				modelEstimates.forEach(estimate => {
					const expectedCost = parseFloat(estimate.output_estimates.expected.cost.replace('$', ''));
					if (expectedCost < lowestExpectedCost) {
						lowestExpectedCost = expectedCost;
						cheapestModel = estimate.model;
					}
				});

				// Calculate potential savings
				const maxCostModel = modelEstimates.reduce((max, current) => {
					const currentCost = parseFloat(current.output_estimates.expected.cost.replace('$', ''));
					const maxCost = parseFloat(max.output_estimates.expected.cost.replace('$', ''));
					return currentCost > maxCost ? current : max;
				}, modelEstimates[0]);
				
				const maxCost = parseFloat(maxCostModel.output_estimates.expected.cost.replace('$', ''));
				const savings = maxCost > 0 ? Math.round((1 - (lowestExpectedCost / maxCost)) * 100) : 0;

				const result = {
					input_analysis: {
						input_tokens: inputTokens,
						detected_task_type: taskType,
						verbosity: verbosity
					},
					model_estimates: modelEstimates,
					recommended_model: cheapestModel,
					savings: `${savings}% cost reduction vs ${maxCostModel.model}`
				};

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(result, null, 2)
						}
					]
				};
			}
		);

		// Tool 3: Get model details
		this.server.tool(
			"get_model_details",
			{
				model: z.string()
			},
			async ({ model: modelName }) => {
				const model = models[modelName];
				
				if (!model) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: `Model '${modelName}' not found`,
									available_models: Object.keys(models)
								}, null, 2)
							}
						]
					};
				}

				const result = {
					name: modelName,
					multimodal: model.multimodal,
					max_context: `${(model.maxContext / 1000).toFixed(0)}K tokens`,
					strengths: model.strengths,
					ideal_use_cases: model.idealUseCases,
					pricing: {
						input: `$${model.pricing.input.toFixed(2)} per 1M tokens`,
						output: `$${model.pricing.output.toFixed(2)} per 1M tokens`
					},
					limitations: model.limitations
				};

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(result, null, 2)
						}
					]
				};
			}
		);

		// Tool 4: Compare models
		this.server.tool(
			"compare_models",
			{
				models: z.array(z.string()),
				comparison_aspects: z.array(z.string()).optional()
			},
			async ({ models: modelNames, comparison_aspects }) => {
				const aspects = comparison_aspects || ["pricing", "context_window", "multimodal", "strengths"];
				
				// Filter to only include valid models
				const validModelNames = modelNames.filter(name => models[name]);
				
				if (validModelNames.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "No valid models specified",
									available_models: Object.keys(models)
								}, null, 2)
							}
						]
					};
				}

				// Create comparison object
				const comparison: Record<string, any> = {};
				
				validModelNames.forEach(name => {
					const model = models[name];
					const modelInfo: Record<string, any> = {};
					
					if (aspects.includes("pricing")) {
						modelInfo.pricing = {
							input: `$${model.pricing.input.toFixed(2)} per 1M tokens`,
							output: `$${model.pricing.output.toFixed(2)} per 1M tokens`
						};
					}
					
					if (aspects.includes("context_window")) {
						modelInfo.context_window = `${(model.maxContext / 1000).toFixed(0)}K tokens`;
					}
					
					if (aspects.includes("multimodal")) {
						modelInfo.multimodal = model.multimodal;
					}
					
					if (aspects.includes("strengths")) {
						modelInfo.strengths = model.strengths;
					}
					
					if (aspects.includes("ideal_use_cases")) {
						modelInfo.ideal_use_cases = model.idealUseCases;
					}
					
					if (aspects.includes("limitations")) {
						modelInfo.limitations = model.limitations;
					}
					
					comparison[name] = modelInfo;
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(comparison, null, 2)
						}
					]
				};
			}
		);
		
		// Tool 5: List all available models
		this.server.tool(
			"list_models",
			{
				categories: z.array(z.string()).optional(),
				include_details: z.boolean().default(false)
			},
			async ({ categories, include_details }) => {
				// Group models by categories if requested
				if (categories && categories.length > 0) {
					const categorizedModels: Record<string, string[]> = {};
					
					// Create requested categories
					categories.forEach(category => {
						categorizedModels[category] = [];
					});
					
					// Add each model to appropriate categories
					Object.entries(models).forEach(([name, model]) => {
						if (categories.includes("flagship") && 
							(name === "GPT-4.1" || name === "GPT-4o" || name === "GPT-4.5")) {
							categorizedModels["flagship"].push(name);
						}
						
						if (categories.includes("multimodal") && model.multimodal) {
							categorizedModels["multimodal"].push(name);
						}
						
						if (categories.includes("cost-optimized") && 
							(name.includes("Mini") || name.includes("Nano"))) {
							categorizedModels["cost-optimized"].push(name);
						}
						
						if (categories.includes("reasoning") && 
							(name === "o1" || name === "o3" || name === "o4-mini")) {
							categorizedModels["reasoning"].push(name);
						}
						
						if (categories.includes("legacy") && 
							(name === "GPT-3.5-Turbo" || name === "GPT-4")) {
							categorizedModels["legacy"].push(name);
						}
					});
					
					// If details are requested, expand each model with basic info
					if (include_details) {
						const result: Record<string, any> = {};
						
						for (const [category, modelNames] of Object.entries(categorizedModels)) {
							result[category] = modelNames.map(name => {
								const model = models[name];
								return {
									name,
									multimodal: model.multimodal,
									max_context: `${(model.maxContext / 1000).toFixed(0)}K tokens`,
									pricing: {
										input: `$${model.pricing.input.toFixed(2)} per 1M tokens`,
										output: `$${model.pricing.output.toFixed(2)} per 1M tokens`
									}
								};
							});
						}
						
						return {
							content: [
								{
									type: "text",
									text: JSON.stringify(result, null, 2)
								}
							]
						};
					}
					
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(categorizedModels, null, 2)
							}
						]
					};
				}
				
				// Simple list of all models
				if (include_details) {
					const modelDetails = Object.entries(models).map(([name, model]) => ({
						name,
						multimodal: model.multimodal,
						max_context: `${(model.maxContext / 1000).toFixed(0)}K tokens`,
						pricing: {
							input: `$${model.pricing.input.toFixed(2)} per 1M tokens`,
							output: `$${model.pricing.output.toFixed(2)} per 1M tokens`
						}
					}));
					
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(modelDetails, null, 2)
							}
						]
					};
				}
				
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(Object.keys(models), null, 2)
						}
					]
				};
			}
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			// @ts-ignore
			return GptModelComparisonMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			// @ts-ignore
			return GptModelComparisonMCP.serve("/mcp").fetch(request, env, ctx);
		}

		// Add a simple homepage with information about the MCP server
		if (url.pathname === "/" || url.pathname === "") {
			return new Response(`
				<html>
					<head>
						<title>GPT Model Comparison MCP Server</title>
						<style>
							body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }
							code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
							pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
							h1, h2, h3 { margin-top: 1.5em; }
							table { border-collapse: collapse; width: 100%; margin: 1em 0; }
							th, td { text-align: left; padding: 8px; border: 1px solid #ddd; }
							th { background-color: #f8f8f8; }
						</style>
					</head>
					<body>
						<h1>GPT Model Comparison MCP Server</h1>
						<p>This MCP server provides tools for comparing and selecting optimal GPT models based on task requirements and cost considerations.</p>
						
						<h2>Available Tools:</h2>
						<ul>
							<li><strong>get_optimal_model</strong> - Get the optimal model based on task requirements</li>
							<li><strong>estimate_text_cost</strong> - Analyze text to estimate costs across models</li>
							<li><strong>get_model_details</strong> - Get comprehensive information about a specific model</li>
							<li><strong>compare_models</strong> - Compare multiple models side-by-side</li>
							<li><strong>list_models</strong> - Get a complete list of all available models with optional categorization</li>
						</ul>
						
						<h2>MCP Endpoints:</h2>
						<ul>
							<li>SSE Endpoint: <code>/sse</code> - Connect via SSE-based MCP clients</li>
							<li>HTTP Endpoint: <code>/mcp</code> - Connect via HTTP-based MCP clients</li>
							<li>Documentation: <code><a href="/schema">/schema</a></code> - View detailed parameter information</li>
						</ul>
						
						<h2>Connection Example:</h2>
						<pre>npx @modelcontextprotocol/inspector@latest</pre>
						<p>Then connect to: <code>${request.url}sse</code></p>
					</body>
				</html>
			`, {
				headers: {
					"Content-Type": "text/html"
				}
			});
		}
		
		// Schema documentation endpoint
		if (url.pathname === "/schema") {
			const toolSchemas = [
				{
					name: "get_optimal_model",
					description: "Get the optimal model based on task requirements",
					parameters: [
						{
							name: "task_type",
							type: "enum",
							values: ["code_generation", "creative_writing", "qa", "summarization", "general"],
							required: true,
							description: "Type of task to perform"
						},
						{
							name: "context_length",
							type: "number",
							default: 1000,
							required: false,
							description: "Approximate input token count"
						},
						{
							name: "multimodal_required",
							type: "boolean",
							default: false,
							required: false,
							description: "Whether vision/audio capabilities are needed"
						},
						{
							name: "optimize_for", 
							type: "enum",
							values: ["cost", "performance", "balanced"],
							default: "balanced",
							required: false,
							description: "Optimization priority"
						},
						{
							name: "max_budget",
							type: "number",
							required: false,
							description: "Optional max cost per request in USD"
						},
						{
							name: "required_features",
							type: "array of strings",
							required: false,
							description: "Specific capabilities needed"
						}
					],
					example: {
						task_type: "code_generation",
						context_length: 5000,
						multimodal_required: false,
						optimize_for: "cost",
						max_budget: 0.05
					}
				},
				{
					name: "estimate_text_cost",
					description: "Analyze text to estimate costs across models",
					parameters: [
						{
							name: "text",
							type: "string",
							required: true,
							description: "The prompt text to analyze"
						},
						{
							name: "models",
							type: "array of strings",
							required: false,
							description: "Optional list of models to check. If not provided, popular models will be used."
						},
						{
							name: "force_brevity",
							type: "boolean",
							default: false,
							required: false,
							description: "Force lower token estimates"
						},
						{
							name: "expected_output",
							type: "number or enum",
							values: ["brief", "medium", "detailed"],
							required: false,
							description: "Expected output size: 'brief' (~100 tokens), 'medium' (~500), 'detailed' (~1500) or exact token count"
						}
					],
					example: {
						text: "Write a story about robots",
						models: ["GPT-4.1", "GPT-4o-Mini"],
						expected_output: "detailed"
					}
				},
				{
					name: "get_model_details",
					description: "Get comprehensive information about a specific model",
					parameters: [
						{
							name: "model",
							type: "string",
							required: true,
							description: "The model name to get details for"
						}
					],
					example: {
						model: "GPT-4o"
					}
				},
				{
					name: "compare_models",
					description: "Compare multiple models side-by-side",
					parameters: [
						{
							name: "models",
							type: "array of strings",
							required: true,
							description: "Array of model names to compare"
						},
						{
							name: "comparison_aspects",
							type: "array of strings",
							required: false,
							description: "Specific aspects to compare (pricing, context_window, multimodal, strengths, ideal_use_cases, limitations)"
						}
					],
					example: {
						models: ["GPT-4.1", "GPT-4o", "GPT-4.1-Mini"],
						comparison_aspects: ["pricing", "multimodal", "strengths"]
					}
				},
				{
					name: "list_models",
					description: "Get a complete list of all available models with optional categorization",
					parameters: [
						{
							name: "categories",
							type: "array of strings",
							required: false,
							description: "Optional categories to group models by (flagship, multimodal, cost-optimized, reasoning, legacy)"
						},
						{
							name: "include_details",
							type: "boolean",
							default: false,
							required: false,
							description: "Include basic details about each model"
						}
					],
					example: {
						categories: ["flagship", "cost-optimized"],
						include_details: true
					}
				}
			];
		
			// Generate HTML for the schema documentation
			let schemaHtml = `
				<!DOCTYPE html>
				<html>
					<head>
						<title>GPT Model Comparison MCP - API Documentation</title>
						<style>
							body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; line-height: 1.6; }
							code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
							pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
							h1, h2, h3 { margin-top: 1.5em; }
							table { border-collapse: collapse; width: 100%; margin: 1em 0; }
							th, td { text-align: left; padding: 8px; border: 1px solid #ddd; }
							th { background-color: #f8f8f8; }
							.required { color: #e74c3c; font-weight: bold; }
							.tool { margin-bottom: 40px; border-bottom: 1px solid #eee; padding-bottom: 20px; }
							.example { margin-top: 15px; }
						</style>
					</head>
					<body>
						<h1>GPT Model Comparison MCP - API Documentation</h1>
						<p>This page documents all available tools and their parameters for testing with the MCP Inspector.</p>
						
						<h2>Tools Summary</h2>
						<ul>
							${toolSchemas.map(tool => `<li><a href="#${tool.name}">${tool.name}</a> - ${tool.description}</li>`).join('\n')}
						</ul>
						
						<h2>Detailed Tool Documentation</h2>
			`;
			
			// Add each tool's documentation
			toolSchemas.forEach(tool => {
				schemaHtml += `
					<div class="tool" id="${tool.name}">
						<h3>${tool.name}</h3>
						<p>${tool.description}</p>
						
						<h4>Parameters</h4>
						<table>
							<tr>
								<th>Name</th>
								<th>Type</th>
								<th>Required</th>
								<th>Default</th>
								<th>Description</th>
							</tr>
							${tool.parameters.map(param => {
								// Handle optional values property
								const valuesStr = 'values' in param && param.values 
									? `<br>Values: ${(param.values as string[]).map(v => `<code>${v}</code>`).join(', ')}`
									: '';
								
								// Handle optional default property
								const defaultStr = 'default' in param && param.default !== undefined
									? `<code>${param.default}</code>`
									: '-';
									
								return `
									<tr>
										<td>${param.name}${param.required ? ' <span class="required">*</span>' : ''}</td>
										<td>${param.type}${valuesStr}</td>
										<td>${param.required ? 'Yes' : 'No'}</td>
										<td>${defaultStr}</td>
										<td>${param.description}</td>
									</tr>
								`;
							}).join('\n')}
						</table>
						
						<div class="example">
							<h4>Example Usage</h4>
							<pre>${JSON.stringify(tool.example, null, 2)}</pre>
						</div>
					</div>
				`;
			});
			
			schemaHtml += `
						<h2>Usage with MCP Inspector</h2>
						<p>When using the MCP Inspector:</p>
						<ol>
							<li>Connect to <code>http://localhost:8787/sse</code></li>
							<li>Click on a tool name in the left panel</li>
							<li>Enter parameters according to the documentation above</li>
							<li>Click "Run Tool" to execute</li>
						</ol>
						
						<p><a href="/">Back to homepage</a></p>
					</body>
				</html>
			`;
			
			return new Response(schemaHtml, {
				headers: {
					"Content-Type": "text/html"
				}
			});
		}

		return new Response("Not found", { status: 404 });
	},
};

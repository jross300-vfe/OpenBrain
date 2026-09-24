/**
 * Unit tests for src/mcp/server.ts
 * Tests tool listing and schema validation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module
vi.mock("../../db/connection.js", () => ({
  getPool: () => ({ query: vi.fn(), connect: vi.fn() }),
}));

vi.mock("../../embedder/index.js", () => ({
  getEmbedder: () => ({
    generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
    extractMetadata: vi.fn().mockResolvedValue({
      type: "observation",
      topics: [],
      people: [],
      action_items: [],
      dates: [],
    }),
  }),
}));

import { createMcpServer } from "../server.js";

describe("MCP Server Tool Listing", () => {
  it("registers exactly 8 tools", async () => {
    const server = createMcpServer();

    // Access tools via the server's internal handler
    // The ListToolsRequestSchema handler returns { tools: [...] }
    const handler = (server as any)._requestHandlers?.get("tools/list");
    expect(handler).toBeDefined();

    const result = await handler({ method: "tools/list" });
    expect(result.tools).toHaveLength(8);

    const toolNames = result.tools.map((t: any) => t.name).sort();
    expect(toolNames).toEqual([
      "capture_thought",
      "capture_thoughts",
      "delete_thought",
      "get_thought",
      "list_thoughts",
      "search_thoughts",
      "thought_stats",
      "update_thought",
    ]);
  });

  it("capture_thought accepts project, source, and supersedes params", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const captureTool = result.tools.find((t: any) => t.name === "capture_thought");
    const props = captureTool.inputSchema.properties;

    expect(props.content).toBeDefined();
    expect(props.project).toBeDefined();
    expect(props.source).toBeDefined();
    expect(props.supersedes).toBeDefined();
    expect(props.created_by).toBeDefined();
    expect(captureTool.inputSchema.required).toContain("content");
  });

  it("search_thoughts accepts project, type, topic, include_archived", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const searchTool = result.tools.find((t: any) => t.name === "search_thoughts");
    const props = searchTool.inputSchema.properties;

    expect(props.query).toBeDefined();
    expect(props.project).toBeDefined();
    expect(props.type).toBeDefined();
    expect(props.topic).toBeDefined();
    expect(props.include_archived).toBeDefined();
    expect(props.created_by).toBeDefined();
  });

  it("list_thoughts accepts project and include_archived", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const listTool = result.tools.find((t: any) => t.name === "list_thoughts");
    const props = listTool.inputSchema.properties;

    expect(props.project).toBeDefined();
    expect(props.include_archived).toBeDefined();
    expect(props.created_by).toBeDefined();
  });

  it("list_thoughts accepts pagination and projection params", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const listTool = result.tools.find((t: any) => t.name === "list_thoughts");
    const props = listTool.inputSchema.properties;

    expect(props.limit).toBeDefined();
    expect(props.limit.type).toBe("integer");
    expect(props.offset).toBeDefined();
    expect(props.offset.type).toBe("integer");
    expect(props.tags_contain).toBeDefined();
    expect(props.minimal).toBeDefined();
    expect(props.minimal.type).toBe("boolean");
  });

  it("get_thought requires id", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const getTool = result.tools.find((t: any) => t.name === "get_thought");
    expect(getTool).toBeDefined();
    expect(getTool.inputSchema.required).toEqual(["id"]);
  });

  it("thought_stats accepts project param", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const statsTool = result.tools.find((t: any) => t.name === "thought_stats");
    expect(statsTool.inputSchema.properties.project).toBeDefined();
    expect(statsTool.inputSchema.properties.created_by).toBeDefined();
  });

  it("update_thought requires only id; content and tags_line are optional alternatives", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const updateTool = result.tools.find((t: any) => t.name === "update_thought");
    expect(updateTool.inputSchema.required).toEqual(["id"]);
    expect(updateTool.inputSchema.properties.content).toBeDefined();
    expect(updateTool.inputSchema.properties.tags_line).toBeDefined();
  });

  it("delete_thought requires id", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const deleteTool = result.tools.find((t: any) => t.name === "delete_thought");
    expect(deleteTool.inputSchema.required).toEqual(["id"]);
  });

  it("capture_thoughts accepts thoughts array, project, source", async () => {
    const server = createMcpServer();
    const handler = (server as any)._requestHandlers?.get("tools/list");
    const result = await handler({ method: "tools/list" });

    const batchTool = result.tools.find((t: any) => t.name === "capture_thoughts");
    const props = batchTool.inputSchema.properties;

    expect(props.thoughts).toBeDefined();
    expect(props.thoughts.type).toBe("array");
    expect(props.project).toBeDefined();
    expect(props.source).toBeDefined();
    expect(props.created_by).toBeDefined();
    expect(batchTool.inputSchema.required).toContain("thoughts");
  });
});

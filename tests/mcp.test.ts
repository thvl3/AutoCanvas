import { it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../src/mcp/server.js";
import { AcademicService } from "../src/services/academic.js";
it("uses official MCP client for schemas, tools, resources and invalid inputs", async () => {
  const repo = {
    list: () => [],
    get: () => undefined,
    syncState: () => null,
    recentChanges: () => [],
  };
  const server = createServer(new AcademicService(repo));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain(
      "canvas_get_assignment_context",
    );
    expect(tools.tools.some((t) => t.name.includes("submit"))).toBe(false);
    const result = await client.callTool({
      name: "canvas_get_upcoming",
      arguments: { days: 7 },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      data: { items: [] },
    });
    const invalid = await client.callTool({
      name: "canvas_get_upcoming",
      arguments: { days: -1 },
    });
    expect(invalid.isError).toBe(true);
    const traversal = await client.callTool({
      name: "canvas_prepare_workspace",
      arguments: { assignment_id: "../../etc" },
    });
    expect(traversal.isError).toBe(true);
    const unknown = await client.callTool({
      name: "canvas_list_courses",
      arguments: { arbitrary_path: "/etc/passwd" },
    });
    expect(unknown.isError).toBe(true);
    const missing = await client.callTool({
      name: "canvas_get_course",
      arguments: { course_id: "404" },
    });
    expect(missing.isError).toBe(true);
    const r = await client.readResource({ uri: "canvas://courses" });
    expect(r.contents[0]).toHaveProperty("text");
    expect(
      (await client.listResourceTemplates()).resourceTemplates.length,
    ).toBeGreaterThan(5);
  } finally {
    await client.close();
    await server.close();
  }
});

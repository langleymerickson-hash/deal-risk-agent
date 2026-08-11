import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

interface StructuredCallParams<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  toolName: string;
  toolDescription: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls Claude with a single forced tool matching `schema`, so the model's
 * reply is always structured JSON rather than free text to parse. Retries a
 * few times on API errors or malformed tool output before giving up — an
 * occasional bad sample shouldn't take down an otherwise-healthy batch run.
 */
export async function callStructured<T>({
  system,
  prompt,
  schema,
  toolName,
  toolDescription,
}: StructuredCallParams<T>): Promise<T> {
  // $refStrategy: "none" forces every nested schema to be inlined instead of
  // deduplicated into a shared $ref+definitions — we only pass the single named
  // definition below to Anthropic, so a $ref pointing elsewhere would dangle.
  const inputSchema = zodToJsonSchema(schema, { name: toolName, $refStrategy: "none" });

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: prompt }],
        tools: [
          {
            name: toolName,
            description: toolDescription,
            input_schema: inputSchema.definitions?.[toolName] as Anthropic.Tool["input_schema"],
          },
        ],
        tool_choice: { type: "tool", name: toolName },
      });

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );
      if (!toolUse) {
        throw new Error(`No tool_use block in response for ${toolName}`);
      }

      return schema.parse(toolUse.input);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

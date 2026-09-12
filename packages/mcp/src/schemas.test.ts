import type { FindingAnchor, McpError, McpResult, McpTools } from "@loom/core";
import { expectTypeOf, test } from "vitest";
import type { z } from "zod";
import {
  type anchorSchema,
  type errorSchema,
  type inputSchemas,
  outputSchemas,
  resultSchema,
} from "./schemas.js";

test("schema output types equal every core input and output (decision 19)", () => {
  type Inputs = {
    [K in keyof typeof inputSchemas]: z.output<(typeof inputSchemas)[K]>;
  };
  type Outputs = {
    [K in keyof typeof outputSchemas]: z.output<(typeof outputSchemas)[K]>;
  };
  expectTypeOf<Inputs>().toEqualTypeOf<{
    [K in keyof McpTools]: McpTools[K]["input"];
  }>();
  // Normalize object intersections while retaining nominal strings and array structure.
  type Normalize<T> = T extends string
    ? T
    : T extends object
      ? { [K in keyof T]: Normalize<T[K]> }
      : T;
  expectTypeOf<Normalize<Outputs>>().toEqualTypeOf<
    Normalize<{ [K in keyof McpTools]: McpTools[K]["output"] }>
  >();
  expectTypeOf<z.output<typeof errorSchema>>().toEqualTypeOf<McpError>();
  expectTypeOf<z.output<typeof anchorSchema>>().toEqualTypeOf<FindingAnchor>();
  const result = resultSchema(outputSchemas.ask_human);
  expectTypeOf<z.output<typeof result>>().toEqualTypeOf<
    McpResult<McpTools["ask_human"]["output"]>
  >();
});

import { delimiter } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

/** The extension's flags as the user typed them; a value of the wrong kind falls back to the default. */
const flagsSchema = z.object({
  agent: z.enum(["auto", "cli", "registry"]).catch("auto"),
  mode: z.string().min(1).optional().catch(undefined),
  directories: z
    .string()
    .optional()
    .catch(undefined)
    .transform((listed) => (listed ?? "").split(delimiter).filter((entry) => entry.trim() !== "")),
  mcp: z.boolean().catch(false),
});

export type Flags = z.output<typeof flagsSchema>;

export function readFlags(pi: Pick<ExtensionAPI, "getFlag">): Flags {
  return flagsSchema.parse({
    agent: pi.getFlag("agy-agent"),
    mode: pi.getFlag("agy-mode"),
    directories: pi.getFlag("agy-dir"),
    mcp: pi.getFlag("agy-mcp"),
  });
}

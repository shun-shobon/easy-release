import * as v from "valibot";

const nonempty = v.pipe(v.string(), v.minLength(1));

export const configSchema = v.strictObject({
  packageFiles: v.array(nonempty),
  tagPrefix: v.optional(v.string(), "v"),
  branchPrefix: v.optional(nonempty, "release/prepare-"),
  updateCommand: v.optional(nonempty),
});

export type Config = v.InferOutput<typeof configSchema>;
